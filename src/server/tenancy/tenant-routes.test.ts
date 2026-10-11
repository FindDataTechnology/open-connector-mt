import type { RunLog } from "../storage/runtime-store.ts";
import type { TenantRouteOptions } from "./tenant-routes.ts";

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { readSessionCookieName } from "./tenant-auth.ts";
import { projectRun, registerTenantRoutes } from "./tenant-routes.ts";

/**
 * add-tenant-runs-card: the tenant run-log route is a projection, so these
 * tests pin the two things that matter — nothing internal escapes, and one
 * tenant never sees another's runs.
 */

interface StubRun extends Partial<RunLog> {
  id: string;
  tenantId?: string;
}

function run(overrides: StubRun): RunLog {
  return {
    id: overrides.id,
    service: overrides.service ?? "github",
    actionId: overrides.actionId ?? "github.list_repositories",
    caller: overrides.caller ?? "mcp",
    startedAt: overrides.startedAt ?? "2026-10-11T00:00:00.000Z",
    completedAt: overrides.completedAt ?? "2026-10-11T00:00:01.500Z",
    ok: overrides.ok ?? true,
    runtimeTokenId: overrides.runtimeTokenId,
    tenantId: overrides.tenantId,
    connectionId: overrides.connectionId,
    connectionProfile: overrides.connectionProfile,
    policy: overrides.policy,
    inputSummary: overrides.inputSummary,
    outputSummary: overrides.outputSummary,
    errorCode: overrides.errorCode,
    errorMessage: overrides.errorMessage,
  } as RunLog;
}

function buildOptions(runs: RunLog[], pats: { id: string; name: string; kind?: string; tenantId?: string }[]) {
  const seen: { tenantId: string; limit: number }[] = [];
  const options = {
    hooks: {
      config: { mode: "oidc" },
      verifySessionCookie: async () => "identity-1",
    },
    config: { mode: "oidc" },
    tenants: {
      getIdentityById: async () => ({ id: "identity-1", tenantId: "t1", disabledAt: null }),
    },
    runtimeTokens: { listTokens: async () => pats },
    oauthFlow: {},
    connections: {},
    catalog: {},
    actions: {
      run: async () => undefined,
      listRuns: async (input: { tenantId: string; limit: number }) => {
        seen.push(input);
        return { items: runs.filter((r) => r.tenantId === input.tenantId).slice(0, input.limit) };
      },
    },
    policyOf: async () => ({ allowedActions: [], blockedActions: [], allowedProxies: [], allowedConnections: [] }),
  } as unknown as TenantRouteOptions;
  return { options, seen };
}

async function request(options: TenantRouteOptions, path: string, cookie?: string): Promise<Response> {
  const app = new Hono();
  registerTenantRoutes(app, options);
  const sessionCookie = cookie ?? `${readSessionCookieName()}=stub-session`;
  return app.request(new Request(`http://localhost${path}`, { headers: { cookie: sessionCookie } }));
}

describe("GET /api/tenant/runs (add-tenant-runs-card)", () => {
  it("scopes the query to the caller's tenant", async () => {
    const runs = [run({ id: "r1", tenantId: "t1" }), run({ id: "r2", tenantId: "t2" })];
    const { options, seen } = buildOptions(runs, []);
    const response = await request(options, "/api/tenant/runs");
    expect(seen[0]?.tenantId).toBe("t1");
    const body = (await response.json()) as { runs: unknown[] };
    expect(body.runs).toHaveLength(1);
  });

  it("projects away every internal identifier", async () => {
    const runs = [
      run({
        id: "r1",
        tenantId: "t1",
        runtimeTokenId: "tok-internal",
        policy: { allowed: true } as never,
        connectionId: "github:default",
        connectionProfile: { displayName: "GitHub (main)" } as never,
      }),
    ];
    const { options } = buildOptions(runs, [{ id: "tok-internal", name: "my-agent" }]);
    const body = (await request(options, "/api/tenant/runs").then((r) => r.json())) as {
      runs: Record<string, unknown>[];
    };
    const row = body.runs[0]!;
    expect(row.runtimeTokenId).toBeUndefined();
    expect(row.tenantId).toBeUndefined();
    expect(row.policy).toBeUndefined();
    expect(row.connectionProfile).toBeUndefined();
    expect(row.patName).toBe("my-agent");
    expect(row.connectionName).toBe("GitHub (main)");
    expect(row.durationMs).toBe(1500);
  });

  it("leaves patName empty for a token outside the tenant (OBO service token)", async () => {
    const runs = [run({ id: "r1", tenantId: "t1", runtimeTokenId: "service-token" })];
    const { options } = buildOptions(runs, [{ id: "own", name: "mine", kind: "user_pat", tenantId: "t1" }]);
    const body = (await request(options, "/api/tenant/runs").then((r) => r.json())) as {
      runs: { patName: string }[];
    };
    expect(body.runs[0]!.patName).toBe("");
  });

  it("clamps limit into 1..20", async () => {
    const runs = Array.from({ length: 30 }, (_, i) => run({ id: `r${i}`, tenantId: "t1" }));
    const high = buildOptions(runs, []);
    await request(high.options, "/api/tenant/runs?limit=500");
    expect(high.seen[0]?.limit).toBe(20);
    const low = buildOptions(runs, []);
    await request(low.options, "/api/tenant/runs?limit=0");
    expect(low.seen[0]?.limit).toBe(1);
    const missing = buildOptions(runs, []);
    await request(missing.options, "/api/tenant/runs");
    expect(missing.seen[0]?.limit).toBe(20);
  });
});

describe("projectRun", () => {
  it("falls back to the connection id when there is no profile", () => {
    const view = projectRun(run({ id: "r", connectionId: "github:default" }), new Map());
    expect(view.connectionName).toBe("github:default");
    expect(view.patName).toBe("");
  });

  it("never reports a negative duration", () => {
    const view = projectRun(
      run({ id: "r", startedAt: "2026-10-11T00:00:05.000Z", completedAt: "2026-10-11T00:00:00.000Z" }),
      new Map(),
    );
    expect(view.durationMs).toBe(0);
  });
});

// add-connector-account-picker: cross-mint endpoint + mutating-route Origin guard.
describe("cross-mint", () => {
  const ALLOWED = "https://yizuo.example";
  const created: { name: string }[] = [];

  function buildCrossOptions(overrides: Partial<TenantRouteOptions> = {}): TenantRouteOptions {
    created.length = 0;
    return {
      hooks: {
        config: { mode: "oidc" },
        verifySessionCookie: async () => "identity-1",
      },
      config: { mode: "oidc", crossMintOrigins: [ALLOWED], crossSiteCookie: false },
      tenants: {
        getIdentityById: async () => ({ id: "identity-1", tenantId: "t1", email: "u@example.com", disabledAt: null }),
      },
      runtimeTokens: {
        listTokens: async () => [{ id: "existing", name: "existing-pat", kind: "user_pat", tenantId: "t1" }],
        createToken: async (name: string) => {
          created.push({ name });
          return {
            token: "oct_new-plaintext",
            record: { id: `new-${created.length}`, name },
          };
        },
      },
      oauthFlow: {},
      connections: {},
      catalog: {},
      actions: { run: async () => undefined, listRuns: async () => ({ items: [] }) },
      policyOf: async () => ({ allowedActions: [], blockedActions: [], allowedProxies: [], allowedConnections: [] }),
      ...overrides,
    } as unknown as TenantRouteOptions;
  }

  async function crossRequest(
    options: TenantRouteOptions,
    path: string,
    init: { method?: string; origin?: string; body?: unknown } = {},
  ): Promise<Response> {
    const app = new Hono();
    registerTenantRoutes(app, options);
    const headers: Record<string, string> = { cookie: `${readSessionCookieName()}=stub-session` };
    if (init.origin) headers.origin = init.origin;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return app.request(
      new Request(`http://localhost${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
  }

  it("registers no routes when the allowlist is empty", async () => {
    const options = buildCrossOptions({
      config: { mode: "oidc", crossMintOrigins: [], crossSiteCookie: false },
    } as unknown as Partial<TenantRouteOptions>);
    const probe = await crossRequest(options, "/api/tenant/cross-mint/probe", { origin: ALLOWED });
    expect(probe.status).toBe(404);
  });

  it("probe: allowlisted origin + session → identity, non-allowlisted → 403 without CORS headers", async () => {
    const options = buildCrossOptions();
    const ok = await crossRequest(options, "/api/tenant/cross-mint/probe", { origin: ALLOWED });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    expect(ok.headers.get("vary")).toContain("Origin");
    expect((await ok.json()) as Record<string, unknown>).toEqual({ email: "u@example.com", displayName: null });

    const denied = await crossRequest(options, "/api/tenant/cross-mint/probe", { origin: "https://evil.example" });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();

    const noHeader = await crossRequest(options, "/api/tenant/cross-mint/probe");
    expect(noHeader.status).toBe(403);
    expect(noHeader.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("probe and mint require a session (401 without)", async () => {
    const options = buildCrossOptions({
      hooks: {
        config: { mode: "oidc" },
        verifySessionCookie: async () => undefined,
      },
    } as unknown as Partial<TenantRouteOptions>);
    const probe = await crossRequest(options, "/api/tenant/cross-mint/probe", { origin: ALLOWED });
    expect(probe.status).toBe(401);
    const mint = await crossRequest(options, "/api/tenant/cross-mint", {
      method: "POST",
      origin: ALLOWED,
      body: { name: "x" },
    });
    expect(mint.status).toBe(401);
    expect(created).toHaveLength(0);
  });

  it("mint: mints a new PAT returning token+id+name exactly once, never existing tokens", async () => {
    const options = buildCrossOptions();
    const minted = await crossRequest(options, "/api/tenant/cross-mint", {
      method: "POST",
      origin: ALLOWED,
      body: { name: "壹座 · a@example.com" },
    });
    expect(minted.status).toBe(200);
    expect(minted.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    const body = (await minted.json()) as { token: string; id: string; name: string };
    expect(body.token).toBe("oct_new-plaintext");
    expect(body.id).toBe("new-1");
    expect(body.name).toBe("壹座 · a@example.com");
    expect(created.map((c) => c.name)).toEqual(["壹座 · a@example.com"]);

    // mint again → a second PAT, not idempotent
    await crossRequest(options, "/api/tenant/cross-mint", { method: "POST", origin: ALLOWED, body: { name: "n" } });
    expect(created).toHaveLength(2);
  });

  it("preflight: allowlisted origin gets methods/headers/credentials; others get 403", async () => {
    const options = buildCrossOptions();
    const ok = await crossRequest(options, "/api/tenant/cross-mint", { method: "OPTIONS", origin: ALLOWED });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(ok.headers.get("access-control-allow-methods")).toBe("GET, POST");
    expect(ok.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");

    const denied = await crossRequest(options, "/api/tenant/cross-mint", {
      method: "OPTIONS",
      origin: "https://x.example",
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("mutating-route Origin guard (cross-site cookie deployments)", () => {
  const ALLOWED = "https://yizuo.example";
  const PUBLIC = "https://connector.example";

  function buildGuardOptions(): TenantRouteOptions {
    return {
      hooks: { config: { mode: "oidc" }, verifySessionCookie: async () => "identity-1" },
      config: { mode: "oidc", crossMintOrigins: [ALLOWED], crossSiteCookie: true },
      tenants: { getIdentityById: async () => ({ id: "identity-1", tenantId: "t1", disabledAt: null }) },
      runtimeTokens: {
        listTokens: async () => [{ id: "p1", name: "pat", kind: "user_pat", tenantId: "t1" }],
        createToken: async (name: string) => ({ token: "oct_t", record: { id: "p2", name } }),
      },
      oauthFlow: {},
      connections: {},
      catalog: {},
      actions: { run: async () => undefined, listRuns: async () => ({ items: [] }) },
      policyOf: async () => ({ allowedActions: [], blockedActions: [], allowedProxies: [], allowedConnections: [] }),
      publicOrigin: PUBLIC,
    } as unknown as TenantRouteOptions;
  }

  async function guardRequest(
    path: string,
    init: { method: string; origin?: string; authorization?: string; body?: unknown; cookie?: boolean },
  ): Promise<Response> {
    const app = new Hono();
    registerTenantRoutes(app, buildGuardOptions());
    const headers: Record<string, string> = {};
    if (init.cookie !== false) headers.cookie = `${readSessionCookieName()}=stub-session`;
    if (init.origin) headers.origin = init.origin;
    if (init.authorization) headers.authorization = init.authorization;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return app.request(
      new Request(`http://localhost${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
  }

  it("blocks cross-site POST/DELETE without an allowlisted origin", async () => {
    const evil = await guardRequest("/api/tenant/pats", { method: "POST", origin: "https://evil.example", body: {} });
    expect(evil.status).toBe(403);
    const del = await guardRequest("/api/tenant/pats/p1", { method: "DELETE", origin: "https://evil.example" });
    expect(del.status).toBe(403);
  });

  it("allows same-origin and allowlisted-origin mutations", async () => {
    const same = await guardRequest("/api/tenant/pats", { method: "POST", origin: PUBLIC, body: { name: "n" } });
    expect(same.status).not.toBe(403);
    const listed = await guardRequest("/api/tenant/pats", { method: "POST", origin: ALLOWED, body: { name: "n" } });
    expect(listed.status).not.toBe(403);
  });

  it("does not disturb GET routes or bearer-only callers", async () => {
    const get = await guardRequest("/api/tenant/pats", { method: "GET", origin: "https://evil.example" });
    expect(get.status).toBe(200);
    // No session cookie → no cookie to blind-fire → the guard lets it through
    // for bearer callers (壹座 backend revocation) to work unchanged.
    const bearer = await guardRequest("/api/tenant/pats", {
      method: "POST",
      authorization: "Bearer oct_t",
      body: { name: "n" },
      cookie: false,
    });
    expect(bearer.status).not.toBe(403);
  });
});
