import type { OperationScope, TokenPolicy } from "../../core/action-policy.ts";
import type { RuntimeLogger } from "../../core/types.ts";

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type TokenKind = "runtime" | "user_pat" | "service_pat";

export interface RuntimeTokenRecord {
  id: string;
  name: string;
  tokenHash: string;
  allowedActions: string[];
  blockedActions: string[];
  allowedProxies: string[];
  allowedConnections: string[];
  allowedTriggers?: string[];
  /** scoped-pat-grants D6: structured `(provider, operationType)` scope, union with allowedActions. */
  allowedOperations?: OperationScope[];
  createdAt: string;
  lastUsedAt?: string;
  /** open-connector-mt: owning tenant (user_pat), null for service_pat, absent = legacy runtime token. */
  tenantId?: string;
  /** open-connector-mt: absent means the upstream "runtime" kind. */
  kind?: TokenKind;
  /** scoped-pat-grants: free-text provenance label (which binding/agent this PAT serves). */
  purpose?: string;
  /** scoped-pat-grants: set when this PAT was minted by attenuating another PAT. */
  parentTokenId?: string;
}

export interface RuntimeTokenSummary {
  id: string;
  name: string;
  /** open-connector-mt: absent = legacy runtime token. */
  kind?: TokenKind;
  tenantId?: string;
  allowedActions: string[];
  blockedActions: string[];
  allowedProxies: string[];
  allowedConnections: string[];
  allowedTriggers?: string[];
  /** scoped-pat-grants D6: `(provider, operationType)` scope; empty/absent = not scoped by class. */
  allowedOperations?: OperationScope[];
  createdAt: string;
  lastUsedAt?: string;
  /** scoped-pat-grants: provenance label, so N PATs on one identity stay distinguishable. */
  purpose?: string;
  /** scoped-pat-grants: attenuation parent, if this token was derived from another. */
  parentTokenId?: string;
}

export interface RuntimeTokenCreation {
  token: string;
  record: RuntimeTokenRecord;
}

export interface IRuntimeTokenStore {
  add(record: RuntimeTokenRecord): Promise<void>;
  list(): Promise<RuntimeTokenRecord[]>;
  findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined>;
  updatePolicy(id: string, policy: TokenPolicy): Promise<RuntimeTokenRecord | undefined>;
  revoke(id: string): Promise<boolean>;
  markUsed(id: string, usedAt: string): Promise<void>;
}

const tokenPrefix = "oct_";

/**
 * Derivation depth cap for revocation cascades (scoped-pat-grants).
 *
 * Attenuated PATs are a strict subset of their parent, so a parent must not be
 * revoked while a live child survives. Real chains are 1–2 deep; the cap keeps a
 * corrupt parent cycle from looping forever.
 */
const revokeCascadeMaxDepth = 4;

export interface RuntimeGrant extends TokenPolicy {
  tokenId: string;
  /** open-connector-mt: present on PATs (user_pat/service_pat); absent = legacy runtime token. */
  kind?: TokenKind;
  /** open-connector-mt: owning tenant for user_pat; undefined for service_pat/legacy. */
  tenantId?: string;
}

export class RuntimeTokenService {
  private readonly store: IRuntimeTokenStore;
  private readonly logger?: RuntimeLogger;

  constructor(store: IRuntimeTokenStore, logger?: RuntimeLogger) {
    this.store = store;
    this.logger = logger;
  }

  async createToken(
    name: string,
    policy: TokenPolicy = {
      allowedActions: [],
      blockedActions: [],
      allowedProxies: [],
      allowedConnections: [],
    },
    /** open-connector-mt: PAT creation passes { kind, tenantId } here; scoped-pat-grants adds { purpose, parentTokenId }. */
    identity?: { kind?: TokenKind; tenantId?: string; purpose?: string; parentTokenId?: string },
  ): Promise<RuntimeTokenCreation> {
    const token = `${tokenPrefix}${randomBytes(32).toString("base64url")}`;
    const now = new Date().toISOString();
    const record: RuntimeTokenRecord = {
      id: randomUUID(),
      name: name.trim(),
      tokenHash: hashRuntimeToken(token),
      allowedActions: policy.allowedActions,
      blockedActions: policy.blockedActions,
      allowedProxies: policy.allowedProxies,
      allowedConnections: policy.allowedConnections ?? [],
      allowedTriggers: policy.allowedTriggers ?? [],
      allowedOperations: policy.allowedOperations ?? [],
      createdAt: now,
      ...(identity ?? {}),
    };
    await this.store.add(record);
    return { token, record };
  }

  async listTokens(): Promise<RuntimeTokenSummary[]> {
    return (await this.store.list()).map(summarizeRuntimeToken);
  }

  /**
   * Revoke a token and every token attenuated from it (scoped-pat-grants).
   *
   * A child's scope is always a subset of its parent's, so revoking the parent
   * must invalidate the children too — otherwise "revoke this PAT" would silently
   * leave a narrower-but-live credential behind. Children are found by walking
   * `parentTokenId`, capped at `revokeCascadeMaxDepth`.
   *
   * The return value keeps the upstream meaning: whether the named token existed.
   *
   * `cascade: false` retires one token without touching its descendants. Same-name
   * re-mints use it: the replacement keeps the union of the old scope, so the old
   * token's children remain within their (unchanged or widened) parent scope.
   */
  async revokeToken(id: string, options: { cascade?: boolean } = {}): Promise<boolean> {
    const removed = await this.store.revoke(id);
    if (options.cascade === false) {
      return removed;
    }
    const seen = new Set<string>([id]);
    let frontier = [id];
    for (let depth = 0; depth < revokeCascadeMaxDepth && frontier.length > 0; depth += 1) {
      let tokens: RuntimeTokenRecord[];
      try {
        tokens = await this.store.list();
      } catch (error) {
        // last_used_at-style best effort: an audit nicety must not fail the revoke
        // the caller asked for. Orphans are reaped by the next revoke of the parent.
        this.logger?.warn({ tokenId: id, err: error }, "derived token lookup failed during revoke");
        break;
      }
      const next = tokens
        .filter((record) => record.parentTokenId && frontier.includes(record.parentTokenId) && !seen.has(record.id))
        .map((record) => record.id);
      for (const childId of next) {
        seen.add(childId);
        await this.store.revoke(childId);
      }
      frontier = next;
    }

    return removed;
  }

  async updateTokenPolicy(id: string, policy: TokenPolicy): Promise<RuntimeTokenSummary | undefined> {
    const record = await this.store.updatePolicy(id, policy);
    return record ? summarizeRuntimeToken(record) : undefined;
  }

  async resolveToken(token: string): Promise<RuntimeGrant | undefined> {
    if (!token.startsWith(tokenPrefix)) {
      return undefined;
    }
    const tokenHash = hashRuntimeToken(token);
    const matched = await this.store.findByHash(tokenHash);
    if (!matched || !equalHashes(matched.tokenHash, tokenHash)) {
      return undefined;
    }

    await this.recordLastUsed(matched.id);
    return {
      tokenId: matched.id,
      allowedActions: matched.allowedActions,
      blockedActions: matched.blockedActions,
      allowedProxies: matched.allowedProxies,
      allowedConnections: matched.allowedConnections ?? [],
      allowedTriggers: matched.allowedTriggers ?? [],
      allowedOperations: matched.allowedOperations ?? [],
      kind: matched.kind,
      tenantId: matched.tenantId,
    };
  }

  async verifyToken(token: string): Promise<boolean> {
    return Boolean(await this.resolveToken(token));
  }

  /**
   * `last_used_at` is best-effort audit metadata, so a failed write is logged
   * instead of turning an authenticated caller into a failed request.
   */
  private async recordLastUsed(tokenId: string): Promise<void> {
    try {
      await this.store.markUsed(tokenId, new Date().toISOString());
    } catch (error) {
      this.logger?.warn({ tokenId, err: error }, "runtime token last use update failed");
    }
  }
}

export function hashRuntimeToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function summarizeRuntimeToken(record: RuntimeTokenRecord): RuntimeTokenSummary {
  return {
    id: record.id,
    name: record.name,
    allowedActions: record.allowedActions,
    blockedActions: record.blockedActions,
    allowedProxies: record.allowedProxies,
    allowedConnections: record.allowedConnections,
    allowedTriggers: record.allowedTriggers ?? [],
    allowedOperations: record.allowedOperations ?? [],
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    tenantId: record.tenantId,
    kind: record.kind,
    purpose: record.purpose,
    parentTokenId: record.parentTokenId,
  };
}

function equalHashes(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
