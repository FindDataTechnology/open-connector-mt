import type { TenantRouteOptions } from "./tenant-routes.ts";
import type { RunLog } from "../storage/runtime-store.ts";

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { projectRun, registerTenantRoutes } from "./tenant-routes.ts";
import { readSessionCookieName } from "./tenant-auth.ts";

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
    const runs = [
      run({ id: "r1", tenantId: "t1" }),
      run({ id: "r2", tenantId: "t2" }),
    ];
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
