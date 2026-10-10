/**
 * Typed client for the tenant console routes (/api/tenant/*, open-connector-mt).
 */
import { apiDelete, apiGet, apiPost } from "../api";

export interface TenantConfig {
  mode: "off" | "oidc";
  issuer: string | null;
  clientId: string | null;
  localeDefault: string | null;
  loginUrl: string | null;
}

export interface TenantSession {
  tenantId: string;
  kind: "admin" | "user_pat" | "service_pat" | "oidc_session";
  email: string | null;
  displayName: string | null;
}

export interface TenantConnection {
  service: string;
  connectionName: string;
  configured: boolean;
  authType?: string;
  status?: string;
  /** true for the auth-free catalog projection every tenant sees (deleting is a no-op). */
  virtual?: boolean;
}

export interface TenantPat {
  id: string;
  name: string;
  lastUsedAt: string | null;
}

/** Run log as the tenant is allowed to see it (projected server-side). */
export interface TenantRun {
  id: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  service?: string;
  actionId?: string;
  caller?: string;
  connectionName?: string;
  errorCode?: string;
  errorMessage?: string;
  inputSummary?: unknown;
  outputSummary?: unknown;
  /** Empty when the run came from a token outside this tenant (e.g. an OBO service token). */
  patName: string;
}

/** Upstream admin session probe (public route; the unlock cookie speaks for itself). */
export interface AdminSession {
  adminAuthConfigured: boolean;
  authenticated: boolean;
}

export interface MintedPat {
  token: string;
  id: string;
  name: string;
}

export const tenantApi = {
  config: () => apiGet<TenantConfig>("/api/tenant/config"),
  /**
   * Whether this browser holds an unlocked admin session. Returns false on any
   * failure — a missing return link is harmless, a wrong one sends a tenant
   * into the unlock wall.
   */
  adminSession: async (): Promise<AdminSession> => {
    try {
      return await apiGet<AdminSession>("/api/auth/session");
    } catch {
      return { adminAuthConfigured: false, authenticated: false };
    }
  },
  session: () => apiGet<TenantSession>("/api/tenant/session"),
  logout: () => apiPost<void>("/api/tenant/logout", {}),
  connections: () => apiGet<{ connections: TenantConnection[] }>("/api/tenant/connections"),
  createConnection: (input: {
    service: string;
    connectionName?: string;
    authType: string;
    values: Record<string, string>;
  }) => apiPost("/api/tenant/connections", input),
  deleteConnection: (service: string, name: string) =>
    apiDelete<unknown>(`/api/tenant/connections/${encodeURIComponent(service)}/${encodeURIComponent(name)}`),
  startOAuth: (service: string, connectionName?: string) =>
    apiPost<{ authorizationUrl: string }>(`/api/tenant/oauth/${encodeURIComponent(service)}/start`, {
      connectionName,
    }),
  pats: () => apiGet<{ pats: TenantPat[] }>("/api/tenant/pats"),
  mintPat: (name: string) => apiPost<MintedPat>("/api/tenant/pats", { name }),
  revokePat: (id: string) => apiDelete<{ id: string; revoked: boolean }>(`/api/tenant/pats/${encodeURIComponent(id)}`),
  runs: (limit?: number) =>
    apiGet<{ runs: TenantRun[] }>(`/api/tenant/runs${limit ? `?limit=${limit}` : ""}`),
  testAction: (input: { actionId: string; input?: unknown; connectionName?: string }) =>
    apiPost<{ ok?: boolean; output?: unknown; errorCode?: string; errorMessage?: string }>(
      "/api/tenant/actions/test",
      input,
    ),
};
