import type { RuntimeGrant, RuntimeTokenRecord } from "../storage/runtime-token-service.ts";
import type { TenantAuthHooks } from "./tenant-auth.ts";
import type { TenantRouteOptions } from "./tenant-routes.ts";
import type { Context } from "hono";

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { ActionPolicySnapshot } from "../../core/action-policy.ts";
import { createLocalAuthMiddleware } from "../api/auth.ts";
import { HttpRequestError, jsonError } from "../api/http-utils.ts";
import { readSessionCookieName } from "./tenant-auth.ts";
import { registerTenantRoutes } from "./tenant-routes.ts";

/**
 * scoped-pat-grants: the mint endpoint is the only place scope can enter the
 * system, so these tests pin the four rules that make scoped PATs safe —
 * satisfiable, tenant-owned, monotone on re-mint, and narrow-only when derived.
 */

type Action = {
  id: string;
  service: string;
  operationType: "read" | "write" | "destructive";
  execution: { locallyExecutable: boolean };
};

function action(id: string, operationType: Action["operationType"], executable = true): Action {
  return { id, service: id.slice(0, id.indexOf(".")), operationType, execution: { locallyExecutable: executable } };
}

const catalogActions = [
  action("kingdee.list_bills", "read"),
  action("kingdee.create_bill", "write"),
  action("readonly.get", "read"),
];

const catalog = {
  providers: [
    {
      service: "kingdee",
      actions: catalogActions.filter((row) => row.service === "kingdee"),
    },
    {
      service: "readonly",
      actions: catalogActions.filter((row) => row.service === "readonly"),
    },
  ],
  actions: catalogActions,
  actionsById: new Map(catalogActions.map((row) => [row.id, row])),
};

class MemoryTokens {
  readonly records: RuntimeTokenRecord[] = [];
  readonly revocations: { id: string; cascade: boolean }[] = [];
  private sequence = 0;

  async createToken(
    name: string,
    policy: {
      allowedActions: string[];
      blockedActions: string[];
      allowedProxies: string[];
      allowedConnections?: string[];
      allowedTriggers?: string[];
      allowedOperations?: { provider: string; operationType: "read" | "write" | "destructive" }[];
    },
    identity: { kind?: string; tenantId?: string; purpose?: string; parentTokenId?: string } = {},
  ) {
    this.sequence += 1;
    const record: RuntimeTokenRecord = {
      id: `token-${this.sequence}`,
      name,
      tokenHash: `hash-${this.sequence}`,
      allowedActions: policy.allowedActions,
      blockedActions: policy.blockedActions,
      allowedProxies: policy.allowedProxies,
      allowedConnections: policy.allowedConnections ?? [],
      allowedTriggers: policy.allowedTriggers ?? [],
      allowedOperations: policy.allowedOperations ?? [],
      createdAt: new Date().toISOString(),
      ...identity,
    } as RuntimeTokenRecord;
    this.records.push(record);
    return { token: `oct_secret_${this.sequence}`, record };
  }

  async listTokens(): Promise<RuntimeTokenRecord[]> {
    return [...this.records];
  }

  async revokeToken(id: string, options: { cascade?: boolean } = {}): Promise<boolean> {
    this.revocations.push({ id, cascade: options.cascade ?? true });
    const at = this.records.findIndex((record) => record.id === id);
    if (at < 0) return false;
    this.records.splice(at, 1);
    return true;
  }
}

function buildOptions(
  input: {
    tokens?: MemoryTokens;
    mode?: "off" | "oidc";
    sessionIdentityId?: string | null;
  } = {},
): { options: TenantRouteOptions; tokens: MemoryTokens } {
  const tokens = input.tokens ?? new MemoryTokens();
  const mode = input.mode ?? "oidc";
  const identityId = input.sessionIdentityId === undefined ? "identity-1" : input.sessionIdentityId;
  const options = {
    hooks:
      mode === "oidc"
        ? {
            config: { mode: "oidc" },
            verifySessionCookie: async () => identityId ?? undefined,
            verifyIdToken: async () => undefined,
            issueSession: async () => {},
            clearSession: () => {},
          }
        : undefined,
    config: { mode, serviceObo: "off", crossMintOrigins: [], crossSiteCookie: false },
    tenants: {
      getIdentityById: async (id: string) => ({ id, tenantId: "t1", disabledAt: null }),
      revokeConsentsForToken: async () => {},
    },
    runtimeTokens: tokens,
    oauthFlow: {},
    connections: {
      listConnections: async () => [{ id: "conn-1" }, { id: "conn-2" }, { id: "conn-other-tenant" }],
    },
    catalog,
    actions: { run: async () => undefined, listRuns: async () => ({ items: [] }) },
    policyOf: async () => policySnapshot(),
  } as unknown as TenantRouteOptions;
  return { options, tokens };
}

function policySnapshot(tokenPolicy?: {
  allowedActions?: string[];
  blockedActions?: string[];
  allowedProxies?: string[];
  allowedConnections?: string[];
}): ActionPolicySnapshot {
  const empty = {
    allowedActions: [],
    blockedActions: [],
    allowedProxies: [],
    blockedProxies: [],
    allowedTriggers: [],
    blockedTriggers: [],
  };
  return new ActionPolicySnapshot(empty, empty, {
    allowedActions: tokenPolicy?.allowedActions ?? [],
    blockedActions: tokenPolicy?.blockedActions ?? [],
    allowedProxies: tokenPolicy?.allowedProxies ?? [],
    allowedConnections: tokenPolicy?.allowedConnections ?? [],
  });
}

function sessionApp(options: TenantRouteOptions): Hono {
  const app = new Hono();
  registerTenantRoutes(app, options);
  return appWithHttpErrors(app);
}

/**
 * The real server maps HttpRequestError to its declared status; the bare Hono
 * app used here would turn it into a 500 and hide a 400 in tests.
 */
function appWithHttpErrors(app: Hono): Hono {
  app.onError((error, context) =>
    error instanceof HttpRequestError
      ? jsonError(context, error.status, error.code, error.message)
      : jsonError(context, 500, "internal_error", "Internal Server Error"),
  );
  return app;
}

async function postPat(
  app: Hono,
  body: Record<string, unknown>,
  headers: Record<string, string> = { cookie: `${readSessionCookieName()}=stub-session` },
): Promise<Response> {
  return app.request(
    new Request("http://localhost/api/tenant/pats", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/tenant/pats — scope (scoped-pat-grants)", () => {
  it("keeps the unscoped response and policy byte-identical to the full-authority PAT", async () => {
    const { options, tokens } = buildOptions();
    const response = await postPat(sessionApp(options), { name: "legacy" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; id: string; name: string };
    expect(Object.keys(body).sort()).toEqual(["id", "name", "token"]);
    expect(body.name).toBe("legacy");
    expect(tokens.records[0]).toMatchObject({
      allowedActions: [],
      blockedActions: [],
      allowedProxies: [],
      allowedConnections: [],
      tenantId: "t1",
    });
  });

  it("stores the requested allowlists", async () => {
    const { options, tokens } = buildOptions();
    const response = await postPat(sessionApp(options), {
      name: "binding:erp/kingdee",
      purpose: "binding:erp/kingdee",
      allowedActions: ["kingdee.*"],
      allowedConnections: ["conn-1"],
    });

    expect(response.status).toBe(200);
    expect(tokens.records[0]).toMatchObject({
      name: "binding:erp/kingdee",
      purpose: "binding:erp/kingdee",
      allowedActions: ["kingdee.*"],
      allowedConnections: ["conn-1"],
    });
  });

  it("rejects an action rule no catalog action can satisfy", async () => {
    const { options, tokens } = buildOptions();
    const response = await postPat(sessionApp(options), { name: "typo", allowedActions: ["kingdee.list_bil"] });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_scope");
    expect(tokens.records).toHaveLength(0);
  });

  it("rejects a connection id this tenant does not own", async () => {
    const { options, tokens } = buildOptions();
    const response = await postPat(sessionApp(options), { name: "x", allowedConnections: ["conn-missing"] });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_scope");
    expect(tokens.records).toHaveLength(0);
  });

  it("rejects scope fields a PAT cannot carry", async () => {
    const { options } = buildOptions();
    const response = await postPat(sessionApp(options), { name: "x", blockedActions: ["kingdee.create_bill"] });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_scope");
  });

  it("mints a PAT scoped to (provider, operationType) instead of action ids", async () => {
    const { options, tokens } = buildOptions();
    const response = await postPat(sessionApp(options), {
      name: "binding:erp/kingdee-read",
      purpose: "binding:erp/kingdee-read",
      allowedOperations: [{ provider: "kingdee", operationType: "read" }],
      allowedConnections: ["conn-1"],
    });

    expect(response.status).toBe(200);
    expect(Object.keys((await response.json()) as object).sort()).toEqual(["id", "name", "token"]);
    // Stored as the tuple, not expanded into ids: "read only" must keep meaning
    // read-only as the provider grows, and must not grant write either.
    expect(tokens.records[0]).toMatchObject({
      allowedActions: [],
      allowedOperations: [{ provider: "kingdee", operationType: "read" }],
      allowedConnections: ["conn-1"],
    });
  });

  it("rejects an operation scope the catalog cannot honour", async () => {
    const { options, tokens } = buildOptions();

    const unknownProvider = await postPat(sessionApp(options), {
      name: "typo",
      allowedOperations: [{ provider: "kingde", operationType: "read" }],
    });
    expect(unknownProvider.status).toBe(400);
    expect(((await unknownProvider.json()) as { error: { code: string } }).error.code).toBe("invalid_scope");

    // Provider exists but has no action of that class.
    const emptyClass = await postPat(sessionApp(options), {
      name: "empty-class",
      allowedOperations: [{ provider: "readonly", operationType: "write" }],
    });
    expect(emptyClass.status).toBe(400);
    expect(tokens.records).toHaveLength(0);
  });

  it("rejects a malformed operation scope", async () => {
    const { options, tokens } = buildOptions();
    const response = await postPat(sessionApp(options), {
      name: "bad",
      allowedOperations: [{ provider: "kingdee", operationType: "delete" }],
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_input");
    expect(tokens.records).toHaveLength(0);
  });

  it("unions the scope on a same-name re-mint and retires the old token without cascading", async () => {
    const { options, tokens } = buildOptions();
    const first = await postPat(sessionApp(options), { name: "binding", allowedActions: ["kingdee.list_bills"] });
    expect(first.status).toBe(200);

    const second = await postPat(sessionApp(options), {
      name: "binding",
      allowedActions: ["kingdee.create_bill"],
      allowedConnections: ["conn-2"],
    });
    expect(second.status).toBe(200);

    expect(tokens.records).toHaveLength(1);
    expect(tokens.records[0]).toMatchObject({
      allowedActions: ["kingdee.create_bill", "kingdee.list_bills"],
      allowedConnections: ["conn-2"],
    });
    // The replaced token's derived children keep working, so no cascade.
    expect(tokens.revocations).toEqual([{ id: "token-1", cascade: false }]);
  });

  it("lists purpose and scope for this tenant only, never plaintext", async () => {
    const { options, tokens } = buildOptions();
    await tokens.createToken(
      "mine",
      {
        allowedActions: ["kingdee.*"],
        blockedActions: [],
        allowedProxies: [],
        allowedConnections: ["conn-1"],
      },
      { kind: "user_pat", tenantId: "t1", purpose: "binding:erp/kingdee" },
    );
    await tokens.createToken(
      "theirs",
      { allowedActions: [], blockedActions: [], allowedProxies: [] },
      {
        kind: "user_pat",
        tenantId: "t2",
      },
    );

    const response = await sessionApp(options).request(
      new Request("http://localhost/api/tenant/pats", {
        headers: { cookie: `${readSessionCookieName()}=stub-session` },
      }),
    );
    const body = (await response.json()) as { pats: Record<string, unknown>[] };

    expect(body.pats).toHaveLength(1);
    expect(body.pats[0]).toMatchObject({
      name: "mine",
      purpose: "binding:erp/kingdee",
      allowedActions: ["kingdee.*"],
      allowedConnections: ["conn-1"],
    });
    expect(JSON.stringify(body)).not.toContain("oct_");
    expect(JSON.stringify(body)).not.toContain("hash-");
  });

  it("hides another tenant's PAT from revoke", async () => {
    const { options, tokens } = buildOptions();
    await tokens.createToken(
      "theirs",
      { allowedActions: [], blockedActions: [], allowedProxies: [] },
      {
        kind: "user_pat",
        tenantId: "t2",
      },
    );

    const response = await sessionApp(options).request(
      new Request("http://localhost/api/tenant/pats/token-1", {
        method: "DELETE",
        headers: { cookie: `${readSessionCookieName()}=stub-session` },
      }),
    );

    expect(response.status).toBe(404);
    expect(tokens.records).toHaveLength(1);
  });
});

describe("off mode (TENANCY=off)", () => {
  function offApp(tokens: MemoryTokens): Hono {
    const { options } = buildOptions({ tokens, mode: "off", sessionIdentityId: null });
    const app = new Hono();
    app.use("*", createLocalAuthMiddleware({ adminToken: "admin-secret" }));
    registerTenantRoutes(app, options);
    return appWithHttpErrors(app);
  }

  it("mints a scoped PAT for the bootstrap tenant with the admin credential", async () => {
    const tokens = new MemoryTokens();
    const response = await postPat(
      offApp(tokens),
      { name: "off", allowedActions: ["kingdee.*"] },
      {
        authorization: "Bearer admin-secret",
      },
    );

    expect(response.status).toBe(200);
    expect(tokens.records[0]).toMatchObject({ tenantId: "local-admin", allowedActions: ["kingdee.*"] });
  });

  it("validates scope in off mode too", async () => {
    const tokens = new MemoryTokens();
    const response = await postPat(
      offApp(tokens),
      { name: "off", allowedActions: ["nope.*"] },
      {
        authorization: "Bearer admin-secret",
      },
    );

    expect(response.status).toBe(400);
    expect(tokens.records).toHaveLength(0);
  });
});

describe("attenuated mint (Bearer user_pat)", () => {
  const parentGrant: RuntimeGrant = {
    tokenId: "parent-1",
    kind: "user_pat",
    tenantId: "t1",
    allowedActions: ["kingdee.*"],
    blockedActions: [],
    allowedProxies: [],
    allowedConnections: ["conn-1"],
    allowedTriggers: [],
  };

  const fullGrant: RuntimeGrant = {
    tokenId: "parent-full",
    kind: "user_pat",
    tenantId: "t1",
    allowedActions: [],
    blockedActions: [],
    allowedProxies: [],
    allowedConnections: [],
    allowedTriggers: [],
  };

  function derivedApp(grant: RuntimeGrant, tokens: MemoryTokens): Hono {
    const { options } = buildOptions({ tokens, sessionIdentityId: null });
    const app = new Hono();
    app.use(
      "*",
      createLocalAuthMiddleware({
        resolveRuntimeToken: async (token) =>
          token === "oct_parent" ? grant : token === "oct_full" ? fullGrant : undefined,
        tenant: {
          resolve: async (
            _context: Context,
            adminAuthenticated: boolean,
            resolved?: { kind?: string; tenantId?: string; tokenId: string },
          ) =>
            adminAuthenticated
              ? undefined
              : resolved?.kind === "user_pat"
                ? { tenantId: resolved.tenantId as string, kind: "user_pat", tokenId: resolved.tokenId }
                : undefined,
        } as unknown as TenantAuthHooks,
      }),
    );
    registerTenantRoutes(app, options);
    return appWithHttpErrors(app);
  }

  it("derives a narrower child from a scoped parent", async () => {
    const tokens = new MemoryTokens();
    const response = await postPat(
      derivedApp(parentGrant, tokens),
      {
        name: "binding:erp/kingdee-read",
        purpose: "binding:erp/kingdee-read",
        allowedActions: ["kingdee.list_bills"],
        allowedConnections: ["conn-1"],
      },
      { authorization: "Bearer oct_parent" },
    );

    expect(response.status).toBe(200);
    expect(tokens.records[0]).toMatchObject({
      allowedActions: ["kingdee.list_bills"],
      allowedConnections: ["conn-1"],
      parentTokenId: "parent-1",
      tenantId: "t1",
      purpose: "binding:erp/kingdee-read",
    });
  });

  it("rejects over-reach instead of trimming it", async () => {
    const tokens = new MemoryTokens();
    const response = await postPat(
      derivedApp(parentGrant, tokens),
      { name: "wide", purpose: "wide", allowedActions: ["readonly.*"] },
      { authorization: "Bearer oct_parent" },
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("scope_not_attenuated");
    expect(tokens.records).toHaveLength(0);
  });

  it("lets a rule-scoped parent derive an operation-scoped child", async () => {
    const tokens = new MemoryTokens();
    // `kingdee.*` covers every class of that provider, so (kingdee, read) is inside it.
    const response = await postPat(
      derivedApp(parentGrant, tokens),
      {
        name: "read-only",
        purpose: "binding:erp/kingdee-read",
        allowedOperations: [{ provider: "kingdee", operationType: "read" }],
      },
      { authorization: "Bearer oct_parent" },
    );

    expect(response.status).toBe(200);
    expect(tokens.records[0]).toMatchObject({
      allowedOperations: [{ provider: "kingdee", operationType: "read" }],
      parentTokenId: "parent-1",
    });
  });

  it("keeps an operation-scoped parent from widening into rules or other classes", async () => {
    const readParent: RuntimeGrant = {
      ...parentGrant,
      allowedActions: [],
      allowedOperations: [{ provider: "kingdee", operationType: "read" }],
    };

    // Same class, expressed as the action it selects: still inside the parent.
    const inside = await postPat(
      derivedApp(readParent, new MemoryTokens()),
      { name: "one-action", purpose: "one-action", allowedActions: ["kingdee.list_bills"] },
      { authorization: "Bearer oct_parent" },
    );
    expect(inside.status).toBe(200);

    // The same rule as a provider wildcard also selects write: widening.
    const wildcard = await postPat(
      derivedApp(readParent, new MemoryTokens()),
      { name: "wild", purpose: "wild", allowedActions: ["kingdee.*"] },
      { authorization: "Bearer oct_parent" },
    );
    expect(wildcard.status).toBe(403);
    expect(((await wildcard.json()) as { error: { code: string } }).error.code).toBe("scope_not_attenuated");

    // A different class of the same provider: widening.
    const otherClass = await postPat(
      derivedApp(readParent, new MemoryTokens()),
      {
        name: "write",
        purpose: "write",
        allowedOperations: [{ provider: "kingdee", operationType: "write" }],
      },
      { authorization: "Bearer oct_parent" },
    );
    expect(otherClass.status).toBe(403);
  });

  it("inherits an operation-scoped parent's scope when the child states none", async () => {
    const readParent: RuntimeGrant = {
      ...parentGrant,
      allowedActions: [],
      allowedOperations: [{ provider: "kingdee", operationType: "read" }],
    };
    const tokens = new MemoryTokens();
    const response = await postPat(
      derivedApp(readParent, tokens),
      { name: "inherit-scope", purpose: "inherit-scope", allowedConnections: ["conn-1"] },
      { authorization: "Bearer oct_parent" },
    );

    expect(response.status).toBe(200);
    expect(tokens.records[0]).toMatchObject({
      allowedActions: [],
      allowedOperations: [{ provider: "kingdee", operationType: "read" }],
      allowedConnections: ["conn-1"],
    });
  });

  it("rejects a connection outside the parent's allowlist", async () => {
    const tokens = new MemoryTokens();
    const response = await postPat(
      derivedApp(parentGrant, tokens),
      { name: "wide", purpose: "wide", allowedConnections: ["conn-2"] },
      { authorization: "Bearer oct_parent" },
    );

    expect(response.status).toBe(403);
    expect(tokens.records).toHaveLength(0);
  });

  it("requires a purpose on derived tokens", async () => {
    const tokens = new MemoryTokens();
    const response = await postPat(
      derivedApp(parentGrant, tokens),
      { name: "no-purpose", allowedActions: ["kingdee.list_bills"] },
      { authorization: "Bearer oct_parent" },
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("purpose_required");
    expect(tokens.records).toHaveLength(0);
  });

  it("lets a full-authority parent derive any satisfiable subset", async () => {
    const tokens = new MemoryTokens();
    const response = await postPat(
      derivedApp(parentGrant, tokens),
      { name: "narrow", purpose: "narrow", allowedActions: ["readonly.get"], allowedConnections: ["conn-2"] },
      { authorization: "Bearer oct_full" },
    );

    expect(response.status).toBe(200);
    expect(tokens.records[0]).toMatchObject({ parentTokenId: "parent-full", allowedActions: ["readonly.get"] });
  });

  it("inherits the parent's blocks so the child cannot widen", async () => {
    const tokens = new MemoryTokens();
    const blocked: RuntimeGrant = { ...parentGrant, blockedActions: ["kingdee.create_bill"] };
    const response = await postPat(
      derivedApp(blocked, tokens),
      { name: "inherit", purpose: "inherit", allowedActions: ["kingdee.*"] },
      { authorization: "Bearer oct_parent" },
    );

    expect(response.status).toBe(200);
    expect(tokens.records[0]).toMatchObject({ blockedActions: ["kingdee.create_bill"] });
  });

  it("keeps derived tokens out of the admin domain", async () => {
    const tokens = new MemoryTokens();
    // A user PAT (derived or not) governs the runtime face only; the admin
    // domain stays behind the administrator credential.
    const response = await derivedApp(parentGrant, tokens).request(
      new Request("http://localhost/api/runtime-policy", {
        headers: { authorization: "Bearer oct_parent" },
      }),
    );

    expect(response.status).toBe(403);
  });

  it("does not let an actor header turn a derived token into an OBO call", async () => {
    const tokens = new MemoryTokens();
    // OBO is a service_pat capability; a user_pat with the actor header still
    // runs as its own tenant, so the header grants nothing.
    const response = await derivedApp(parentGrant, tokens).request(
      new Request("http://localhost/api/tenant/session", {
        headers: { authorization: "Bearer oct_parent", "x-oo-connector-actor-sub": "someone-else" },
      }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { tenantId: string; kind: string }).toMatchObject({
      tenantId: "t1",
      kind: "user_pat",
    });
  });
});

describe("scope introspection (read-only)", () => {
  async function getJson(options: TenantRouteOptions, path: string) {
    const response = await sessionApp(options).request(
      new Request(`http://localhost${path}`, {
        headers: { cookie: `${readSessionCookieName()}=stub-session` },
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("explains a denied action with provider, operation type and the missing layer", async () => {
    const { options } = buildOptions();
    options.policyOf = async () => policySnapshot({ allowedActions: ["kingdee.*"] });

    const { status, body } = await getJson(options, "/api/tenant/scope-explain?actionId=readonly.get");

    expect(status).toBe(200);
    expect(body).toMatchObject({
      actionId: "readonly.get",
      provider: "readonly",
      operationType: "read",
      allowed: false,
      code: "action_not_allowed",
    });
    expect(body.checks).toEqual([{ source: "token", outcome: "allow_miss" }]);
  });

  it("points at the deployment layer when that is what blocks", async () => {
    const { options } = buildOptions();
    const empty = {
      allowedActions: [],
      blockedActions: [],
      allowedProxies: [],
      blockedProxies: [],
      allowedTriggers: [],
      blockedTriggers: [],
    };
    options.policyOf = async () =>
      new ActionPolicySnapshot({ ...empty, blockedActions: ["kingdee.create_bill"] }, empty, {
        allowedActions: [],
        blockedActions: [],
        allowedProxies: [],
        allowedConnections: [],
      });

    const { body } = await getJson(options, "/api/tenant/scope-explain?actionId=kingdee.create_bill");

    expect(body).toMatchObject({ allowed: false, code: "action_blocked" });
    expect(body.checks).toEqual([{ source: "deployment", outcome: "block_match", rule: "kingdee.create_bill" }]);
  });

  it("distinguishes an unknown action from a denied one", async () => {
    const { options } = buildOptions();
    const { status, body } = await getJson(options, "/api/tenant/scope-explain?actionId=kingdee.lst_bils");

    expect(status).toBe(404);
    expect((body.error as { code: string }).code).toBe("unknown_action");
  });

  it("reports catalog coverage per operation class", async () => {
    const { options } = buildOptions();

    const readWrite = await getJson(options, "/api/tenant/catalog-coverage?provider=kingdee&operations=read,write");
    expect(readWrite.status).toBe(200);
    expect(readWrite.body).toMatchObject({
      provider: "kingdee",
      operations: [
        { operation: "read", covered: true, actionCount: 1, executableActionCount: 1 },
        { operation: "write", covered: true, actionCount: 1, executableActionCount: 1 },
      ],
      gaps: [],
    });

    const gap = await getJson(options, "/api/tenant/catalog-coverage?provider=readonly&operations=read,write");
    expect(gap.body).toMatchObject({
      operations: [
        { operation: "read", covered: true, actionCount: 1 },
        { operation: "write", covered: false, actionCount: 0, executableActionCount: 0 },
      ],
      gaps: ["write"],
    });
  });

  it("answers coverage for a provider with no connection, and 404s an unknown one", async () => {
    const { options } = buildOptions();
    options.connections = { listConnections: async () => [] } as unknown as TenantRouteOptions["connections"];

    const covered = await getJson(options, "/api/tenant/catalog-coverage?provider=kingdee");
    expect(covered.status).toBe(200);
    expect(covered.body.gaps).toEqual([]);

    const unknown = await getJson(options, "/api/tenant/catalog-coverage?provider=nope");
    expect(unknown.status).toBe(404);
    expect((unknown.body.error as { code: string }).code).toBe("unknown_provider");
  });

  it("rejects an unknown operation class instead of silently ignoring it", async () => {
    const { options } = buildOptions();
    const { status } = await getJson(options, "/api/tenant/catalog-coverage?provider=kingdee&operations=read,delete");

    expect(status).toBe(400);
  });

  it("has no side effects: no execution, no token change", async () => {
    const { options, tokens } = buildOptions();
    const run = vi.fn(async () => undefined);
    options.actions.run = run as unknown as TenantRouteOptions["actions"]["run"];
    const before = JSON.stringify(await tokens.listTokens());

    await getJson(options, "/api/tenant/scope-explain?actionId=kingdee.list_bills");
    await getJson(options, "/api/tenant/catalog-coverage?provider=kingdee");

    expect(run).not.toHaveBeenCalled();
    expect(tokens.revocations).toHaveLength(0);
    expect(JSON.stringify(await tokens.listTokens())).toEqual(before);
  });
});
