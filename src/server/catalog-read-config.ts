// Catalog read surface configuration (open-connector-mt).
//
// The catalog is the only fact a pack market needs in order to say "this
// declared external system can actually be honoured". Nothing on the tenant
// plane can answer it for a service: `/api/tenant/*` needs a signed-in user, a
// service token without an actor has no tenant by design, and the admin surface
// is far too much authority to hand a market service. So the read surface is its
// own thing, behind its own switch and its own credential.
//
// Shape mirrors `readTenancyConfig`: a pure function over an env snapshot, so the
// deployment's choice is testable without touching `process.env`.

export type CatalogReadMode = "off" | "public" | "service";

export interface CatalogReadConfig {
  mode: CatalogReadMode;
  /** Only present (and required) in `service` mode. */
  token?: string;
}

export const CATALOG_READ_MODE_ENV = "OOMOL_CONNECT_CATALOG_READ";
export const CATALOG_READ_TOKEN_ENV = "OOMOL_CONNECT_CATALOG_READ_TOKEN";

const MODES: readonly CatalogReadMode[] = ["public", "service"];

/**
 * Read the surface's configuration.
 *
 * Fails loudly on purpose:
 *   - an unrecognized mode must not fall back to `off` (the operator believes the
 *     market can read the catalog and gets silent 404s) nor to `public` (a typo
 *     becomes "open to the world");
 *   - `service` without a token must not boot into "reject everything forever".
 *
 * Throwing here means the failure is a startup failure naming the variable,
 * which is the only version of this that gets fixed.
 */
export function readCatalogReadConfig(env: Record<string, string | undefined>): CatalogReadConfig {
  const raw = (env[CATALOG_READ_MODE_ENV] ?? "").trim();
  if (!raw || raw === "off") return { mode: "off" };
  if (!MODES.includes(raw as CatalogReadMode)) {
    throw new Error(`${CATALOG_READ_MODE_ENV} must be one of: off, public, service (got "${raw}")`);
  }
  const mode = raw as CatalogReadMode;
  if (mode === "public") return { mode };
  const token = (env[CATALOG_READ_TOKEN_ENV] ?? "").trim();
  if (!token) {
    throw new Error(`${CATALOG_READ_MODE_ENV}=service requires ${CATALOG_READ_TOKEN_ENV} to be set`);
  }
  return { mode, token };
}

/** The one-line startup fact, so an operator can confirm what is actually on. */
export function describeCatalogReadConfig(config: CatalogReadConfig): string {
  return `catalog read surface: ${config.mode}`;
}
