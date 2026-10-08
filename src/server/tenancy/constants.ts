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
}

export function readTenancyConfig(env: Record<string, string | undefined> = process.env): TenancyConfig {
  const mode = (env.TENANCY || "off").trim() === "oidc" ? "oidc" : "off";
  const serviceOboRaw = (env.SERVICE_OBO || "off").trim();
  const serviceObo = serviceOboRaw === "allow-all" ? "allow-all" : serviceOboRaw === "consent" ? "consent" : "off";
  return {
    mode,
    jwksUri: env.OOMOL_CONNECT_JWKS_URI?.trim() || undefined,
    issuer: env.OOMOL_CONNECT_JWT_ISSUER?.trim() || undefined,
    audience: env.OOMOL_CONNECT_JWT_AUDIENCE?.trim() || undefined,
    clientId: env.OOMOL_CONNECT_OIDC_CLIENT_ID?.trim() || undefined,
    serviceObo,
    localeDefault: env.LOCALE_DEFAULT?.trim() || undefined,
  };
}
