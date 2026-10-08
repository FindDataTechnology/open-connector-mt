/**
 * Per-request tenant context (open-connector-mt).
 *
 * The auth middleware wraps tenant principals' requests in runWithTenant, so
 * every downstream store call (connections, OAuth states, runs) resolves its
 * default tenant from here instead of threading a parameter through the whole
 * call graph. Outside a tenant context — TENANCY=off, admin principals,
 * startup jobs — the default is the bootstrap tenant, which is exactly the
 * upstream single-tenant behavior.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { BOOTSTRAP_TENANT_ID } from "./constants.ts";

export interface TenantRequestContext {
  tenantId: string;
  /** OBO audit: the service token acting for the tenant, when present. */
  serviceTokenId?: string;
  identityId?: string;
}

const storage = new AsyncLocalStorage<TenantRequestContext>();

/** Run `fn` with every tenant-defaulted store call scoped to `tenantId`. */
export function runWithTenant<T>(context: TenantRequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

/**
 * The tenant store writes/reads default to. Bootstrap outside a tenant
 * context = upstream behavior; the request's (actor) tenant inside one.
 */
export function currentStoreTenant(): string {
  return storage.getStore()?.tenantId ?? BOOTSTRAP_TENANT_ID;
}

/** Audit fields for run logs, when running inside a tenant context. */
export function currentTenantAudit(): TenantRequestContext | undefined {
  return storage.getStore();
}
