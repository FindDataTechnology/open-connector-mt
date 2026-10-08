/**
 * Tenant authentication (open-connector-mt).
 *
 * In TENANCY=oidc mode every request must resolve to a TenantPrincipal before
 * it passes the local auth middleware:
 *   - admin bearer → cross-tenant admin principal (checked first, upstream logic untouched)
 *   - bearer PAT   → the runtime token grant carries kind + tenantId (user_pat / service_pat),
 *                    optionally acting on behalf of `x-oo-connector-actor-sub` under SERVICE_OBO
 *   - OIDC session cookie → the console session minted by /api/tenant/login
 *
 * In TENANCY=off the hooks are never constructed, so this module stays unloaded
 * and upstream behavior is untouched.
 */
import type { Context } from "hono";

import type { TenancyConfig } from "./constants.ts";
import { BOOTSTRAP_TENANT_ID } from "./constants.ts";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { ITenantStore } from "../storage/tenant-store.ts";
import type { TokenKind } from "../storage/runtime-token-service.ts";

export interface TenantPrincipal {
  tenantId: string;
  kind: "admin" | "user_pat" | "service_pat" | "oidc_session";
  identityId?: string;
  tokenId?: string;
  /** OBO: the tenant the request effectively executes for (the actor's tenant). */
  actorTenantId?: string;
  /** OBO: the acting service token id, recorded on runs for audit. */
  serviceTokenId?: string;
}

export interface VerifiedOidcIdentity {
  issuer: string;
  subject: string;
  email?: string;
  displayName?: string;
}

export interface TenantAuthHooks {
  readonly config: TenancyConfig;
  /** Verify a bearer/cookie against the deployment's identity and return the principal, or undefined. */
  resolve(context: Context, adminAuthenticated: boolean, grant?: TenantGrantLike): Promise<TenantPrincipal | undefined>;
  /** Mint an OIDC session cookie after a verified login (ID token already checked). */
  issueSession(context: Context, identityId: string): Promise<void>;
  clearSession(context: Context): void;
  /** Verify a raw OIDC ID token (signature, issuer, audience, expiry) via the deployment JWKS. */
  verifyIdToken(idToken: string): Promise<VerifiedOidcIdentity | undefined>;
  /** Validate a session cookie value; returns the identityId it was issued for. */
  verifySessionCookie(value: string): Promise<string | undefined>;
}

/** The subset of RuntimeGrant the resolver needs (avoids an import cycle with the auth middleware). */
export interface TenantGrantLike {
  tokenId: string;
  kind?: TokenKind;
  tenantId?: string;
}

export const actorHeaderName = "x-oo-connector-actor-sub";
const sessionCookieName = "oomol_connect_tenant_session";
const sessionCookieVersion = "v1";
const sessionMaxAgeSeconds = 2_592_000; // 30 days, mirrors the admin session cookie
const sessionMaxAgeMs = sessionMaxAgeSeconds * 1000;

export function readSessionCookieName(): string {
  return sessionCookieName;
}

interface SessionKeyMaterial {
  encryptionKey?: string;
  adminToken?: string;
}

export async function createTenantAuthHooks(deps: {
  config: TenancyConfig;
  tenantStore: ITenantStore;
  sessionKey: SessionKeyMaterial;
  fetchImpl?: typeof fetch;
}): Promise<TenantAuthHooks> {
  const { config, tenantStore } = deps;
  if (config.mode !== "oidc") {
    throw new Error("tenant auth hooks are only constructed in TENANCY=oidc mode");
  }
  // Fail-fast: an OIDC deployment without a usable JWKS+issuer+audience would
  // otherwise fall open. Mirrors createRuntimeJwtVerifier's all-or-nothing rule.
  if (!config.jwksUri || !config.issuer || !config.audience) {
    throw new Error(
      "TENANCY=oidc requires OOMOL_CONNECT_JWKS_URI, OOMOL_CONNECT_JWT_ISSUER and OOMOL_CONNECT_JWT_AUDIENCE together.",
    );
  }

  const { createRemoteJWKSet, jwtVerify } = await import("jose");
  const jwks = createRemoteJWKSet(new URL(config.jwksUri));
  const sessionKey = await deriveSessionKey(deps.sessionKey);

  async function verifyIdToken(idToken: string): Promise<VerifiedOidcIdentity | undefined> {
    try {
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ["exp", "sub"],
      });
      if (typeof payload.sub !== "string") return undefined;
      return {
        issuer: payload.iss ?? (config.issuer as string),
        subject: payload.sub,
        email: typeof payload.email === "string" ? payload.email : undefined,
        displayName:
          typeof payload.name === "string" ? payload.name : typeof payload.preferred_username === "string" ? payload.preferred_username : undefined,
      };
    } catch {
      return undefined;
    }
  }

  async function sign(payload: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", utf8(sessionKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return Buffer.from(await crypto.subtle.sign("HMAC", key, utf8(payload))).toString("base64url");
  }

  async function issueSession(context: Context, identityId: string): Promise<void> {
    const payload = `${sessionCookieVersion}.${Date.now()}.${identityId}`;
    setCookie(context, sessionCookieName, `${payload}.${await sign(payload)}`, {
      httpOnly: true,
      maxAge: sessionMaxAgeSeconds,
      sameSite: "Lax", // the OIDC redirect round-trip is a cross-site navigation
      secure: context.req.url.startsWith("https://"),
      path: "/",
    });
  }

  function clearSession(context: Context): void {
    deleteCookie(context, sessionCookieName, { httpOnly: true, sameSite: "Lax", path: "/" });
  }

  async function verifySessionCookie(value: string): Promise<string | undefined> {
    const [version, issuedAt, identityId, signature, ...extra] = value.split(".");
    if (version !== sessionCookieVersion || !issuedAt || !identityId || !signature || extra.length > 0) return undefined;
    const issuedAtMs = Number(issuedAt);
    if (!Number.isFinite(issuedAtMs) || issuedAtMs > Date.now() || Date.now() - issuedAtMs > sessionMaxAgeMs) {
      return undefined;
    }
    const expected = await sign(`${version}.${issuedAt}.${identityId}`);
    if (!constantTimeEqual(signature, expected)) return undefined;
    return identityId;
  }

  async function resolve(
    context: Context,
    adminAuthenticated: boolean,
    grant?: TenantGrantLike,
  ): Promise<TenantPrincipal | undefined> {
    if (adminAuthenticated) {
      return { tenantId: BOOTSTRAP_TENANT_ID, kind: "admin" };
    }

    // PAT path: the grant was already hash-verified by the runtime token store.
    if (grant) {
      if (grant.kind === "user_pat") {
        if (!grant.tenantId) return undefined;
        // A disabled identity kills its tenant's tokens immediately (fail closed).
        if (await tenantDisabledForToken(tenantStore, grant.tenantId)) return undefined;
        return { tenantId: grant.tenantId, kind: "user_pat", tokenId: grant.tokenId };
      }
      if (grant.kind === "service_pat") {
        return resolveServicePat(context, tenantStore, config, grant.tokenId);
      }
      return undefined; // plain runtime tokens carry no tenant authority in MT mode
    }

    // OIDC session path.
    const cookie = getCookie(context, sessionCookieName);
    if (!cookie) return undefined;
    const identityId = await verifySessionCookie(cookie);
    if (!identityId) return undefined;
    const identity = await tenantStore.getIdentityById(identityId);
    if (!identity || identity.disabledAt) return undefined;
    return { tenantId: identity.tenantId, kind: "oidc_session", identityId: identity.id };
  }

  async function resolveServicePat(
    context: Context,
    store: ITenantStore,
    cfg: TenancyConfig,
    tokenId: string,
  ): Promise<TenantPrincipal | undefined> {
    const actorSub = context.req.header(actorHeaderName)?.trim();
    if (!actorSub) {
      // A service token without an actor has no tenant of its own; it may only
      // serve tenant-scoped reads of nothing. Treat as unauthenticated for
      // tenant purposes.
      return undefined;
    }
    if (cfg.serviceObo === "off") return undefined;
    const identity = await store.getIdentity(cfg.issuer as string, actorSub);
    if (!identity || identity.disabledAt) return undefined;
    if (cfg.serviceObo === "consent" && !(await store.hasConsent(identity.tenantId, tokenId))) {
      return undefined;
    }
    return {
      tenantId: identity.tenantId,
      kind: "service_pat",
      tokenId,
      actorTenantId: identity.tenantId,
      serviceTokenId: tokenId,
    };
  }

  return {
    config,
    resolve,
    issueSession,
    clearSession,
    verifyIdToken,
    verifySessionCookie,
  };
}

async function tenantDisabledForToken(store: ITenantStore, tenantId: string): Promise<boolean> {
  // Disabled-ness lives on the identity; a user PAT is valid only while its
  // owning identity is enabled (v1: one identity per tenant).
  const identity = await store.getIdentityByTenant(tenantId);
  return Boolean(identity?.disabledAt);
}

async function deriveSessionKey({ encryptionKey, adminToken }: SessionKeyMaterial): Promise<string> {
  const material = encryptionKey?.trim() || adminToken?.trim();
  if (material) return material;
  // No deploy secret configured: per-process random key. Sessions do not
  // survive restarts, which is the safe failure mode for an unkeyed deployment.
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function utf8(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer as ArrayBuffer;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
