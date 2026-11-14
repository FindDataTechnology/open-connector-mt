// Tenancy constants shared by storage and API layers (open-connector-mt).
//
// BOOTSTRAP_TENANT_ID is where every row lands when TENANCY=off and what
// pre-0018 rows migrated onto: the upstream single-tenant behavior expressed
// as one reserved tenant. PLATFORM_TENANT_ID owns platform-level OAuth client
// configs (usable by every tenant; tenant-specific rows win on lookup).
//
// OIDC verification reuses the upstream JWKS settings (OOMOL_CONNECT_JWKS_URI
// / _ISSUER / _AUDIENCE) so one configuration serves both auth paths.

export const BOOTSTRAP_TENANT_ID = "local-admin";
export const PLATFORM_TENANT_ID = "platform";

export type TenancyMode = "off" | "oidc";

export interface TenancyConfig {
  mode: TenancyMode;
  jwksUri?: string;
  issuer?: string;
  audience?: string;
  /** Console OIDC public client id (PKCE); OOMOL_CONNECT_OIDC_CLIENT_ID. */
  clientId?: string;
  /** SERVICE_OBO: off (default) | allow-all | consent */
  serviceObo: "off" | "allow-all" | "consent";
  /** LOCALE_DEFAULT: deployment default console language, en when unset. */
  localeDefault?: string;
  /** OOMOL_CONNECT_CROSS_MINT_ORIGINS: exact origins allowed to call the cross-mint
   * endpoint from a browser. Empty disables the endpoint entirely (no routes registered). */
  crossMintOrigins: string[];
  /** OOMOL_CONNECT_CROSS_SITE_COOKIE: when on, tenant session cookies are
   * SameSite=None; Secure so cross-mint fetches can carry them; also arms the
   * Origin guard on mutating /api/tenant/* routes (D8 of the account picker). */
  crossSiteCookie: boolean;
}

export function readTenancyConfig(env: Record<string, string | undefined> = process.env): TenancyConfig {
  const mode = (env.TENANCY || "off").trim() === "oidc" ? "oidc" : "off";
  const serviceOboRaw = (env.SERVICE_OBO || "off").trim();
  const serviceObo = serviceOboRaw === "allow-all" ? "allow-all" : serviceOboRaw === "consent" ? "consent" : "off";
  const crossMintOrigins = (env.OOMOL_CONNECT_CROSS_MINT_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return {
    mode,
    jwksUri: env.OOMOL_CONNECT_JWKS_URI?.trim() || undefined,
    issuer: env.OOMOL_CONNECT_JWT_ISSUER?.trim() || undefined,
    audience: env.OOMOL_CONNECT_JWT_AUDIENCE?.trim() || undefined,
    clientId: env.OOMOL_CONNECT_OIDC_CLIENT_ID?.trim() || undefined,
    serviceObo,
    localeDefault: env.LOCALE_DEFAULT?.trim() || undefined,
    crossMintOrigins,
    crossSiteCookie: (env.OOMOL_CONNECT_CROSS_SITE_COOKIE ?? "").trim() === "1",
  };
}

/**
 * One-line boot description of the identity key space that service OBO (D10 of
 * paas add-served-agent-connector-access) depends on.
 *
 * Service OBO looks an actor up by `(issuer, sub)` — the row was written by
 * whoever signed in at THIS deployment's OIDC console. A caller that
 * signed in under a different issuer therefore reads as `actor_unregistered`,
 * which is the same answer as "never signed in": fail-closed, but a wrong story
 * to hand an operator. Printing the issuer at boot makes "the two ends point at
 * one issuer" checkable by reading one line, instead of by shelling into the pod
 * after every visitor has already been refused.
 *
 * Returns `undefined` when tenancy is off: there is no key space then, and a
 * line saying so on every non-OIDC deployment is noise (SERVICE_OBO is inert).
 */
export function describeServiceIdentity(config: TenancyConfig): string | undefined {
  if (config.mode !== "oidc") return undefined;
  const issuer = config.issuer ?? "(unset)";
  return `service OBO: ${config.serviceObo}; actors resolve against issuer ${issuer} — a caller signed in under another issuer reads as actor_unregistered`;
}
