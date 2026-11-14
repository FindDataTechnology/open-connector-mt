import type { RuntimeTokenService } from "../storage/runtime-token-service.ts";
import type { TenantRouteOptions } from "./tenant-routes.ts";

import { Hono } from "hono";
import { exportJWK, generateKeyPair } from "jose";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createLocalAuthMiddleware } from "../api/auth.ts";
import { RuntimeTokenService as TokenService } from "../storage/runtime-token-service.ts";
import { SqliteRuntimeDatabase } from "../storage/sqlite/runtime-store.ts";
import { actorHeaderName, createTenantAuthHooks } from "./tenant-auth.ts";
import { registerTenantRoutes } from "./tenant-routes.ts";

/**
 * Service identity preflight (`GET /api/tenant/service-whoami`).
 *
 * A service token acting on behalf of an actor fails for five different reasons,
 * and each one is repaired by a different person:
 *
 *   actor_header_missing  → the caller forgot to say who it acts for
 *   obo_disabled          → ops must enable the tier (SERVICE_OBO)
 *   actor_unregistered    → the actor must sign in here once
 *   actor_disabled        → the actor's account was turned off
 *   consent_missing       → the actor's tenant must consent
 *
 * `requireUser` collapses all five into a bare 401, which is right for
 * authorization and useless for repair. These tests pin the reason, and — just as
 * importantly — that the preflight cannot disagree with `resolve()`: both call
 * the same `serviceIdentityOf`.
 */

async function withJwks(): Promise<{
  jwksUri: string;
  issuer: string;
  audience: string;
  close: () => Promise<void>;
}> {
  const { publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  const jwks = { keys: [{ ...jwk, kid: "test-key", alg: "ES256", use: "sig" }] };
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(jwks));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    jwksUri: `http://127.0.0.1:${address.port}/jwks`,
    issuer: "https://idp.example",
    audience: "console-client",
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function emptyPolicy() {
  return { allowedActions: [], blockedActions: [], allowedProxies: [], allowedConnections: [] };
}

interface Harness {
  /** The deployment for the current OBO tier; replaced wholesale on a flip. */
  readonly app: Hono;
  tokens: RuntimeTokenService;
  tenants: SqliteRuntimeDatabase["tenantStore"];
  close: () => Promise<void>;
  setServiceObo: (mode: "off" | "allow-all" | "consent") => Promise<void>;
}

/** One deployment whose OBO tier can be flipped between requests. */
async function buildHarness(serviceObo: "off" | "allow-all" | "consent"): Promise<Harness> {
  const jwks = await withJwks();
  const database = new SqliteRuntimeDatabase(":memory:");
  const tokens = new TokenService(database.runtimeTokenStore);
  const tenants = database.tenantStore;

  // The hooks capture the tier, so a flip builds a new app. The store and token
  // service are shared: re-mounting must not disturb minted credentials.
  const mount = async (mode: "off" | "allow-all" | "consent"): Promise<Hono> => {
    const hooks = await createTenantAuthHooks({
      config: {
        mode: "oidc",
        jwksUri: jwks.jwksUri,
        issuer: jwks.issuer,
        audience: jwks.audience,
        serviceObo: mode,
        crossMintOrigins: [],
        crossSiteCookie: false,
      },
      tenantStore: tenants,
      sessionKey: { encryptionKey: "k" },
    });
    const app = new Hono();
    // The preflight needs the grant the auth middleware stashes: on the public
    // /api/tenant/* path it resolves the bearer without gating, which is exactly
    // how a service token with no actor reaches the route at all.
    app.use("*", createLocalAuthMiddleware({ tenant: hooks, resolveRuntimeToken: (t) => tokens.resolveToken(t) }));
    // Only the preflight route is exercised; it reads hooks/config and the tenant
    // store, so the console's other collaborators stay stubbed.
    registerTenantRoutes(app, {
      hooks,
      config: hooks.config,
      tenants,
      runtimeTokens: tokens,
      connections: { listConnections: async () => [], set: async () => {}, delete: async () => {} },
      catalog: { providers: [], actions: [], actionsById: new Map() },
      actions: { run: async () => undefined, listRuns: async () => ({ items: [] }) },
      policyOf: async () => ({ allowedActions: [], blockedActions: [], allowedProxies: [], allowedConnections: [] }),
      publicOrigin: "https://connector.example.test",
    } as unknown as TenantRouteOptions);
    return app;
  };

  let current = await mount(serviceObo);

  return {
    get app() {
      return current;
    },
    tokens,
    tenants,
    close: async () => {
      await jwks.close();
      database.close();
    },
    setServiceObo: async (next) => {
      current = await mount(next);
    },
  };
}

describe("service identity preflight", () => {
  it("answers 403 for non-service tokens: this endpoint is about service identity", async () => {
    const harness = await buildHarness("allow-all");
    try {
      const { identity } = await harness.tenants.upsertIdentity({
        issuer: "https://idp.example",
        subject: "a-user",
      });
      const { token } = await harness.tokens.createToken("mine", emptyPolicy(), {
        kind: "user_pat",
        tenantId: identity.tenantId,
      });
      const response = await harness.app.request("/api/tenant/service-whoami", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_a_service_token");
    } finally {
      await harness.close();
    }
  });

  it("names a missing actor header instead of a bare 401", async () => {
    const harness = await buildHarness("allow-all");
    try {
      const { token } = await harness.tokens.createToken("facet", emptyPolicy(), { kind: "service_pat" });
      const response = await harness.app.request("/api/tenant/service-whoami", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("actor_header_missing");
    } finally {
      await harness.close();
    }
  });

  it("names the disabled tier — the fix is ops, not the caller", async () => {
    const harness = await buildHarness("off");
    try {
      await harness.tenants.upsertIdentity({ issuer: "https://idp.example", subject: "known-user" });
      const { token } = await harness.tokens.createToken("facet", emptyPolicy(), { kind: "service_pat" });
      const response = await harness.app.request("/api/tenant/service-whoami", {
        headers: { authorization: `Bearer ${token}`, [actorHeaderName]: "known-user" },
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("obo_disabled");
    } finally {
      await harness.close();
    }
  });

  it("names an unregistered actor — the fix is a single sign-in", async () => {
    const harness = await buildHarness("allow-all");
    try {
      const { token } = await harness.tokens.createToken("facet", emptyPolicy(), { kind: "service_pat" });
      const response = await harness.app.request("/api/tenant/service-whoami", {
        headers: { authorization: `Bearer ${token}`, [actorHeaderName]: "never-signed-in" },
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("actor_unregistered");
    } finally {
      await harness.close();
    }
  });

  it("names a disabled actor apart from an unregistered one", async () => {
    const harness = await buildHarness("allow-all");
    try {
      const { identity } = await harness.tenants.upsertIdentity({
        issuer: "https://idp.example",
        subject: "suspended-user",
      });
      await harness.tenants.setIdentityDisabled(identity.id, true);
      const { token } = await harness.tokens.createToken("facet", emptyPolicy(), { kind: "service_pat" });
      const response = await harness.app.request("/api/tenant/service-whoami", {
        headers: { authorization: `Bearer ${token}`, [actorHeaderName]: "suspended-user" },
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("actor_disabled");
    } finally {
      await harness.close();
    }
  });

  it("answers with the actor's tenant when everything holds", async () => {
    const harness = await buildHarness("allow-all");
    try {
      const { identity } = await harness.tenants.upsertIdentity({
        issuer: "https://idp.example",
        subject: "happy-user",
      });
      const { token, record } = await harness.tokens.createToken("facet", emptyPolicy(), { kind: "service_pat" });
      const response = await harness.app.request("/api/tenant/service-whoami", {
        headers: { authorization: `Bearer ${token}`, [actorHeaderName]: "happy-user" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, tenantId: identity.tenantId, tokenId: record.id });
    } finally {
      await harness.close();
    }
  });

  it("answers 404 where tenancy is off: there is no service identity to explain", async () => {
    // TENANCY=off: the console routes still register (scoped PATs behave the same
    // in both modes), but there are no OIDC hooks, so no service identity exists.
    const app = new Hono();
    registerTenantRoutes(app, {
      hooks: undefined,
      config: { mode: "off", serviceObo: "off", crossMintOrigins: [], crossSiteCookie: false },
      tenants: {},
      runtimeTokens: {},
    } as unknown as TenantRouteOptions);
    const response = await app.request("/api/tenant/service-whoami");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("tenancy_disabled");
  });

  it("agrees with the authorization path: a success here is the same fact resolve() computed", async () => {
    const harness = await buildHarness("allow-all");
    try {
      const { identity } = await harness.tenants.upsertIdentity({
        issuer: "https://idp.example",
        subject: "same-fact-user",
      });
      const { token } = await harness.tokens.createToken("facet", emptyPolicy(), { kind: "service_pat" });
      const headers = { authorization: `Bearer ${token}`, [actorHeaderName]: "same-fact-user" };

      // The preflight says yes...
      const whoami = await harness.app.request("/api/tenant/service-whoami", { headers });
      expect(whoami.status).toBe(200);
      // ...and a tenant-scoped route that needs the same principal also says yes.
      const session = await harness.app.request("/api/tenant/session", { headers });
      expect(session.status).toBe(200);
      expect(((await session.json()) as { tenantId: string }).tenantId).toBe(identity.tenantId);

      // Flip the tier off: both must now refuse, still consistently.
      await harness.setServiceObo("off");
      expect((await harness.app.request("/api/tenant/service-whoami", { headers })).status).toBe(401);
      expect((await harness.app.request("/api/tenant/session", { headers })).status).toBe(401);
    } finally {
      await harness.close();
    }
  });
});
