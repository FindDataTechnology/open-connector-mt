/**
 * Tenant registry, identities and OBO consents (open-connector-mt).
 *
 * One store shared by the SQL backends (SQLite, PostgreSQL, D1) through the
 * same RequestTransaction the other generic stores use, so the dialect layer
 * keeps converting `?` placeholders. Bootstrap/platform tenant ids live in
 * ../tenancy/constants.ts.
 */
import { randomUUID } from "node:crypto";

import { BOOTSTRAP_TENANT_ID } from "../tenancy/constants.ts";
import type { RequestTransaction } from "./connection-request-store.ts";
import type { RuntimeRow } from "./runtime-sql.ts";
import type { TokenKind } from "./runtime-token-service.ts";

import { readString } from "./runtime-sql.ts";

export interface TenantRecord {
  id: string;
  kind: "user" | string;
  createdAt: string;
  disabledAt?: string;
}

export interface IdentityRecord {
  id: string;
  tenantId: string;
  issuer: string;
  subject: string;
  email?: string;
  displayName?: string;
  createdAt: string;
  disabledAt?: string;
}

export interface UpsertIdentityInput {
  issuer: string;
  subject: string;
  email?: string;
  displayName?: string;
}

export interface ITenantStore {
  /** First-seen identity registration: creates the identity and its user tenant, or returns the existing pair. */
  upsertIdentity(input: UpsertIdentityInput): Promise<{ identity: IdentityRecord; created: boolean }>;
  getIdentity(issuer: string, subject: string): Promise<IdentityRecord | undefined>;
  getIdentityById(id: string): Promise<IdentityRecord | undefined>;
  /** Disable (or re-enable) an identity; a disabled identity's tokens fail closed at the auth layer. */
  setIdentityDisabled(id: string, disabled: boolean): Promise<void>;
  /** Delete an identity, its tenant and every resource owned by that tenant (data destruction right). */
  deleteIdentityCascade(id: string): Promise<void>;
  getTenant(id: string): Promise<TenantRecord | undefined>;
  /** Grant (idempotent) or check a service token's consent to act for a tenant. */
  grantConsent(tenantId: string, tokenId: string): Promise<void>;
  hasConsent(tenantId: string, tokenId: string): Promise<boolean>;
  /** Drop consents when their service token is revoked (no orphan rows). */
  revokeConsentsForToken(tokenId: string): Promise<void>;
}

function readTenantRow(row: RuntimeRow): TenantRecord {
  return {
    id: readString(row, "id"),
    kind: readString(row, "kind"),
    createdAt: readString(row, "created_at"),
    disabledAt: row["disabled_at"] == null ? undefined : readString(row, "disabled_at"),
  };
}

function readIdentityRow(row: RuntimeRow): IdentityRecord {
  return {
    id: readString(row, "id"),
    tenantId: readString(row, "tenant_id"),
    issuer: readString(row, "issuer"),
    subject: readString(row, "subject"),
    email: row["email"] == null ? undefined : readString(row, "email"),
    displayName: row["display_name"] == null ? undefined : readString(row, "display_name"),
    createdAt: readString(row, "created_at"),
    disabledAt: row["disabled_at"] == null ? undefined : readString(row, "disabled_at"),
  };
}

export class TenantStore implements ITenantStore {
  private readonly transaction: RequestTransaction;

  constructor(transaction: RequestTransaction) {
    this.transaction = transaction;
  }

  async upsertIdentity(input: UpsertIdentityInput): Promise<{ identity: IdentityRecord; created: boolean }> {
    const now = new Date().toISOString();
    const [existingRows] = await this.transaction([
      { sql: "select * from identities where issuer = ? and subject = ?", values: [input.issuer, input.subject] },
    ]);
    const existing = existingRows[0] ? readIdentityRow(existingRows[0]) : undefined;
    if (existing) {
      // Refresh the profile fields on every login; tenant binding never changes.
      const [, [row]] = await this.transaction([
        {
          sql: "update identities set email = ?, display_name = ? where id = ?",
          values: [input.email ?? null, input.displayName ?? null, existing.id],
        },
        { sql: "select * from identities where id = ?", values: [existing.id] },
      ]);
      return { identity: row ? readIdentityRow(row) : existing, created: false };
    }

    const tenantId = randomUUID();
    const identityId = randomUUID();
    await this.transaction([
      { sql: "insert into tenants (id, kind, created_at) values (?, 'user', ?)", values: [tenantId, now] },
      {
        sql: `insert into identities (id, tenant_id, issuer, subject, email, display_name, created_at)
          values (?, ?, ?, ?, ?, ?, ?)
          on conflict(issuer, subject) do update set email = excluded.email, display_name = excluded.display_name
          returning id`,
        values: [identityId, tenantId, input.issuer, input.subject, input.email ?? null, input.displayName ?? null, now],
      },
    ]);
    const identity = await this.getIdentityById(identityId);
    if (!identity) throw new Error("identity insert vanished");
    return { identity, created: true };
  }

  async getIdentity(issuer: string, subject: string): Promise<IdentityRecord | undefined> {
    const [rows] = await this.transaction([
      { sql: "select * from identities where issuer = ? and subject = ?", values: [issuer, subject] },
    ]);
    return rows[0] ? readIdentityRow(rows[0]) : undefined;
  }

  async getIdentityById(id: string): Promise<IdentityRecord | undefined> {
    const [rows] = await this.transaction([{ sql: "select * from identities where id = ?", values: [id] }]);
    return rows[0] ? readIdentityRow(rows[0]) : undefined;
  }

  async setIdentityDisabled(id: string, disabled: boolean): Promise<void> {
    await this.transaction([
      {
        sql: "update identities set disabled_at = ? where id = ?",
        values: [disabled ? new Date().toISOString() : null, id],
      },
    ]);
  }

  async deleteIdentityCascade(id: string): Promise<void> {
    const identity = await this.getIdentityById(id);
    if (!identity) return;
    const tenantId = identity.tenantId;
    if (tenantId === BOOTSTRAP_TENANT_ID) {
      // The bootstrap tenant is a structural shared row, not deletable data.
      throw new Error("refusing to delete the bootstrap tenant via identity cascade");
    }
    await this.transaction([
      { sql: "delete from consents where tenant_id = ?", values: [tenantId] },
      { sql: "delete from runtime_tokens where tenant_id = ?", values: [tenantId] },
      { sql: "delete from oauth_states where tenant_id = ?", values: [tenantId] },
      { sql: "delete from connections where tenant_id = ?", values: [tenantId] },
      { sql: "delete from identities where id = ?", values: [id] },
      { sql: "delete from tenants where id = ?", values: [tenantId] },
    ]);
  }

  async getTenant(id: string): Promise<TenantRecord | undefined> {
    const [rows] = await this.transaction([{ sql: "select * from tenants where id = ?", values: [id] }]);
    return rows[0] ? readTenantRow(rows[0]) : undefined;
  }

  async grantConsent(tenantId: string, tokenId: string): Promise<void> {
    await this.transaction([
      {
        sql: `insert into consents (tenant_id, token_id, granted_at) values (?, ?, ?)
          on conflict(tenant_id, token_id) do nothing`,
        values: [tenantId, tokenId, new Date().toISOString()],
      },
    ]);
  }

  async hasConsent(tenantId: string, tokenId: string): Promise<boolean> {
    const [rows] = await this.transaction([
      { sql: "select 1 as ok from consents where tenant_id = ? and token_id = ?", values: [tenantId, tokenId] },
    ]);
    return rows.length > 0;
  }

  async revokeConsentsForToken(tokenId: string): Promise<void> {
    await this.transaction([{ sql: "delete from consents where token_id = ?", values: [tokenId] }]);
  }
}
