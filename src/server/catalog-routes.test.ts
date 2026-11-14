import type { CatalogStore } from "../catalog-store.ts";
import type { TenantRouteOptions } from "./tenancy/tenant-routes.ts";

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { coverageOf, parseCoverageOperations } from "./catalog-coverage.ts";
import { registerCatalogRoutes } from "./catalog-routes.ts";
import { readSessionCookieName } from "./tenancy/tenant-auth.ts";
import { registerTenantRoutes } from "./tenancy/tenant-routes.ts";

/**
 * The catalog read surface exists so a service (the pack market) can ask whether
 * the catalog can honour a declared external system, without being handed a
 * tenant identity or an admin credential.
 *
 * Pinned here: the mode gate, the read-only posture, the leak boundary (nothing
 * but catalog facts), and one thing that is easy to lose in review — the two
 * planes must answer the coverage question identically.
 */

type OperationType = "read" | "write" | "destructive";

interface FakeAction {
  id: string;
  operationType: OperationType;
  execution: { locallyExecutable: boolean };
}

function action(id: string, operationType: OperationType, executable = true): FakeAction {
  return { id, operationType, execution: { locallyExecutable: executable } };
}

function provider(service: string, actions: FakeAction[]) {
  return {
    service,
    displayName: `${service} display`,
    categories: ["commerce"],
    authTypes: ["api_key"],
    actions: actions.map((row) => ({ ...row, service })),
  };
}

const kingdeeActions = [
  action("kingdee.list_bills", "read"),
  action("kingdee.create_bill", "write"),
  // Catalogued but not runnable here: the write class must report a gap.
  action("kingdee.close_period", "write", false),
];
const stripeActions = [action("stripe.list_payouts", "read")];
// Catalogued but not runnable at all: the whole point of `covered` being
// `executableActionCount > 0` rather than `actionCount > 0`.
const catalogOnlyActions = [action("catalogonly.create_invoice", "write", false)];

const providers = [
  provider("kingdee", kingdeeActions),
  provider("stripe", stripeActions),
  provider("catalogonly", catalogOnlyActions),
];
const allActions = providers.flatMap((row) => row.actions);

const catalog = {
  providers,
  actions: allActions,
  actionsById: new Map(allActions.map((row) => [row.id, row])),
} as unknown as CatalogStore;

function app(options: { mode: "public" | "service"; token?: string } = { mode: "public" }): Hono {
  const instance = new Hono();
  registerCatalogRoutes(instance, { ...options, catalog });
  return instance;
}

describe("catalog read surface: mode gate", () => {
  it("answers anonymously in public mode", async () => {
    const response = await app({ mode: "public" }).request("/api/catalog/providers");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: { service: string }[] };
    expect(body.providers.map((row) => row.service)).toEqual(["kingdee", "stripe", "catalogonly"]);
  });

  it("rejects a missing credential with 401, not 404", async () => {
    const response = await app({ mode: "service", token: "tok_catalog" }).request("/api/catalog/providers");
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects a wrong credential", async () => {
    const response = await app({ mode: "service", token: "tok_catalog" }).request("/api/catalog/providers", {
      headers: { authorization: "Bearer tok_other" },
    });
    expect(response.status).toBe(401);
  });

  it("does not accept a longer token that starts with the real one", async () => {
    // Length mismatch must fail even though the prefix matches: a naive
    // startsWith/startsWith-ish comparison would let this through.
    const response = await app({ mode: "service", token: "tok_catalog" }).request("/api/catalog/providers", {
      headers: { authorization: "Bearer tok_catalogextra" },
    });
    expect(response.status).toBe(401);
  });

  it("accepts the dedicated credential", async () => {
    const response = await app({ mode: "service", token: "tok_catalog" }).request("/api/catalog/providers", {
      headers: { authorization: "Bearer tok_catalog" },
    });
    expect(response.status).toBe(200);
  });

  it("fails closed when service mode was assembled without a token", async () => {
    // readCatalogReadConfig throws at boot, so this only guards a hand-built
    // options object: better a 401 than an unguarded surface.
    const response = await app({ mode: "service" }).request("/api/catalog/providers");
    expect(response.status).toBe(401);
  });
});

describe("catalog read surface: endpoints", () => {
  it("lists providers with metadata only", async () => {
    const response = await app().request("/api/catalog/providers");
    const body = (await response.json()) as { providers: Record<string, unknown>[] };
    expect(body.providers[0]).toEqual({
      service: "kingdee",
      displayName: "kingdee display",
      categories: ["commerce"],
      authTypes: ["api_key"],
      actionCount: 3,
    });
  });

  it("returns one provider, and 404 for an unknown one", async () => {
    const known = await app().request("/api/catalog/providers/kingdee");
    expect(known.status).toBe(200);
    const unknown = await app().request("/api/catalog/providers/nope");
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("unknown_provider");
  });

  it("reports coverage with the executable-count semantics", async () => {
    const response = await app().request("/api/catalog/coverage?provider=kingdee&operations=read,write");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "kingdee",
      operations: [
        { operation: "read", covered: true, actionCount: 1, executableActionCount: 1 },
        { operation: "write", covered: true, actionCount: 2, executableActionCount: 1 },
      ],
      gaps: [],
    });
  });

  it("names the gap when the class has only non-executable actions", async () => {
    // Catalogued and not runnable is a capability gap; an empty class is a gap
    // too, but the two are told apart by actionCount.
    const catalogued = await app().request("/api/catalog/coverage?provider=catalogonly&operations=write");
    expect(await catalogued.json()).toEqual({
      provider: "catalogonly",
      operations: [{ operation: "write", covered: false, actionCount: 1, executableActionCount: 0 }],
      gaps: ["write"],
    });
    const empty = await app().request("/api/catalog/coverage?provider=kingdee&operations=destructive");
    const body = (await empty.json()) as { gaps: string[]; operations: { covered: boolean; actionCount: number }[] };
    expect(body.gaps).toEqual(["destructive"]);
    expect(body.operations[0]).toMatchObject({ covered: false, actionCount: 0 });
  });

  it("rejects a malformed operations value and a missing provider", async () => {
    expect((await app().request("/api/catalog/coverage?provider=kingdee&operations=read,readd")).status).toBe(400);
    expect((await app().request("/api/catalog/coverage?operations=read")).status).toBe(400);
  });

  it("distinguishes an unknown provider from an all-zero coverage", async () => {
    const response = await app().request("/api/catalog/coverage?provider=nope");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("unknown_provider");
  });

  it("answers action ownership without policy or schemas", async () => {
    const response = await app().request("/api/catalog/actions/kingdee.close_period");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      actionId: "kingdee.close_period",
      provider: "kingdee",
      operationType: "write",
      executable: false,
    });
    const unknown = await app().request("/api/catalog/actions/nope.nothing");
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("unknown_action");
  });

  it("answers every write verb with 405", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await app().request("/api/catalog/providers", { method });
      expect(response.status, method).toBe(405);
    }
  });
});

describe("catalog read surface: leak boundary", () => {
  const FORBIDDEN = ["connection", "tenant", "identity", "pat", "run", "secret", "credential"];

  function keysDeep(value: unknown, found: string[] = []): string[] {
    if (Array.isArray(value)) {
      for (const entry of value) keysDeep(entry, found);
    } else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        found.push(key);
        keysDeep(entry, found);
      }
    }
    return found;
  }

  it("returns catalog facts only, at every nesting depth", async () => {
    const paths = [
      "/api/catalog/providers",
      "/api/catalog/providers/kingdee",
      "/api/catalog/coverage?provider=kingdee&operations=read,write",
      "/api/catalog/actions/kingdee.list_bills",
    ];
    for (const path of paths) {
      const body = await (await app().request(path)).json();
      const keys = keysDeep(body).map((key) => key.toLowerCase());
      for (const banned of FORBIDDEN) {
        expect(
          keys.filter((key) => key.includes(banned)),
          `${path} leaked a "${banned}" key`,
        ).toEqual([]);
      }
    }
  });

  it("cannot differ per caller: two credentials get byte-identical answers", async () => {
    const one = await (
      await app({ mode: "service", token: "tok_catalog" }).request("/api/catalog/providers", {
        headers: { authorization: "Bearer tok_catalog" },
      })
    ).text();
    const two = await (await app({ mode: "public" }).request("/api/catalog/providers")).text();
    expect(one).toBe(two);
  });
});

describe("catalog coverage: one owner for the question", () => {
  it("parses operation lists strictly", () => {
    expect(parseCoverageOperations(undefined)).toEqual(["read", "write"]);
    expect(parseCoverageOperations("write")).toEqual(["write"]);
    expect(parseCoverageOperations("write,read,write")).toEqual(["write", "read"]);
    expect(parseCoverageOperations("read,readd")).toBeUndefined();
    expect(parseCoverageOperations("")).toBeUndefined();
  });

  it("the tenant plane and the catalog plane give the same answer", async () => {
    // Two consumers, one calculation. A re-inlined copy on the tenant side would
    // drift (say by counting non-executable actions) and no user-facing test
    // would catch it — this one does.
    const tenantApp = new Hono();
    const options = {
      catalog,
      config: { mode: "oidc" },
      hooks: {
        config: { mode: "oidc" },
        verifySessionCookie: async () => "identity-1",
        verifyIdToken: async () => undefined,
        issueSession: async () => {},
        clearSession: () => {},
      },
      tenants: { getIdentityById: async () => ({ id: "identity-1", tenantId: "tenant-1" }) },
    } as unknown as TenantRouteOptions;
    registerTenantRoutes(tenantApp, options);

    const cookie = `${readSessionCookieName()}=anything`;
    // `catalogonly` is the discriminating case: its write class has an action but
    // no executable one, so an implementation that re-inlines the count drifts here.
    for (const providerId of ["kingdee", "stripe", "catalogonly"]) {
      const tenantResponse = await tenantApp.request(
        `/api/tenant/catalog-coverage?provider=${providerId}&operations=read,write`,
        { headers: { cookie } },
      );
      expect(tenantResponse.status, providerId).toBe(200);
      const tenantBody = await tenantResponse.json();
      const catalogBody = await (
        await app().request(`/api/catalog/coverage?provider=${providerId}&operations=read,write`)
      ).json();
      expect(catalogBody, providerId).toEqual(tenantBody);
      expect(catalogBody).toEqual(coverageOf(catalog, providerId, ["read", "write"]));
    }
  });
});
