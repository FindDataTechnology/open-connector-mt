import type { TenantAuthHooks } from "./tenant-auth.ts";
import type { Context } from "hono";
import type { Server } from "node:http";

import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalAuthMiddleware } from "../api/auth.ts";
import { RuntimeTokenService } from "../storage/runtime-token-service.ts";
import { SqliteRuntimeDatabase } from "../storage/sqlite/runtime-store.ts";
import { TenantStore } from "../storage/tenant-store.ts";
import { readTenancyConfig } from "./constants.ts";
import { currentStoreTenant } from "./request-context.ts";
import { createTenantAuthHooks, actorHeaderName } from "./tenant-auth.ts";

async function withJwksServer(): Promise<{
  jwksUri: string;
  issuer: string;
  audience: string;
  signIdToken: (claims: Record<string, unknown>) => Promise<string>;
  close: () => Promise<void>;
}> {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  const jwks = { keys: [{ ...jwk, kid: "test-key", alg: "ES256", use: "sig" }] };
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(jwks));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const jwksUri = `http://127.0.0.1:${address.port}/jwks`;
  const issuer = "https://idp.example";
  const audience = "console-client";
  return {
    jwksUri,
    issuer,
    audience,
    signIdToken: async (claims) => {
      const { iss, aud, exp, ...rest } = claims as Record<string, unknown> & {
        iss?: string;
        aud?: string;
        exp?: number;
      };
      return new SignJWT({ email: "u@example.com", name: "User", ...rest })
        .setProtectedHeader({ alg: "ES256", kid: "test-key" })
        .setIssuedAt()
        .setIssuer(iss ?? issuer)
        .setAudience(aud ?? audience)
        .setExpirationTime(exp ?? "10m")
        .sign(privateKey);
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function capturedContext(_app: Hono | unknown, path: string, headers: Record<string, string> = {}) {
  // A fresh app per capture: Hono cannot add routes after the first request.
  const app = new Hono();
  let captured: Context | undefined;
  app.use("*", async (context, next) => {
    captured = context;
    await next();
  });
  await app.request(path, { headers });
  if (!captured) throw new Error("context not captured");
  return captured;
}

function emptyPolicy() {
  return { allowedActions: [], blockedActions: [], allowedProxies: [], allowedConnections: [] };
}

describe("tenant auth hooks", () => {
  let jwks: Awaited<ReturnType<typeof withJwksServer>>;
  let hooks: TenantAuthHooks;
  let database: SqliteRuntimeDatabase;
  let tokens: RuntimeTokenService;
  let tenants: TenantStore;

  beforeAll(async () => {
    jwks = await withJwksServer();
    database = new SqliteRuntimeDatabase(":memory:");
    tokens = new RuntimeTokenService(database.runtimeTokenStore);
    tenants = database.tenantStore;
    hooks = await createTenantAuthHooks({
      config: {
        mode: "oidc",
        jwksUri: jwks.jwksUri,
        issuer: jwks.issuer,
        audience: jwks.audience,
        clientId: "console-client",
        serviceObo: "allow-all",
      },
      tenantStore: tenants,
      sessionKey: { encryptionKey: "test-encryption-key" },
    });
  });

  afterAll(async () => {
    await jwks.close();
    database.close();
  });

  it("reads the tenancy config from env", () => {
    const config = readTenancyConfig({
      TENANCY: "oidc",
      OOMOL_CONNECT_JWKS_URI: "https://idp/jwks",
      OOMOL_CONNECT_JWT_ISSUER: "https://idp",
      OOMOL_CONNECT_JWT_AUDIENCE: "client",
      OOMOL_CONNECT_OIDC_CLIENT_ID: "client",
      SERVICE_OBO: "consent",
      LOCALE_DEFAULT: "zh-CN",
    });
    expect(config.mode).toBe("oidc");
    expect(config.serviceObo).toBe("consent");
    expect(config.localeDefault).toBe("zh-CN");
    expect(readTenancyConfig({}).mode).toBe("off");
    expect(readTenancyConfig({}).serviceObo).toBe("off");
  });

  it("refuses construction in off mode or with incomplete OIDC settings", async () => {
    await expect(
      createTenantAuthHooks({
        config: { mode: "off", serviceObo: "off" },
        tenantStore: tenants,
        sessionKey: {},
      }),
    ).rejects.toThrow(/only constructed in TENANCY=oidc/);
    await expect(
      createTenantAuthHooks({
        config: { mode: "oidc", jwksUri: jwks.jwksUri, serviceObo: "off" },
        tenantStore: tenants,
        sessionKey: {},
      }),
    ).rejects.toThrow(/requires OOMOL_CONNECT_JWKS_URI/);
  });

  it("verifies a good ID token and rejects bad issuer/audience/expiry", async () => {
    const good = await jwks.signIdToken({ sub: "sub-ok" });
    expect(await hooks.verifyIdToken(good)).toMatchObject({ issuer: jwks.issuer, subject: "sub-ok" });

    const wrongAud = await jwks.signIdToken({ sub: "sub-ok", aud: "other-client" });
    expect(await hooks.verifyIdToken(wrongAud)).toBeUndefined();

    const expired = await jwks.signIdToken({ sub: "sub-ok", exp: Math.floor(Date.now() / 1000) - 60 });
    expect(await hooks.verifyIdToken(expired)).toBeUndefined();

    expect(await hooks.verifyIdToken("not-a-jwt")).toBeUndefined();
  });

  it("issues and verifies a session cookie bound to the identity", async () => {
    const context = await capturedContext(null, "https://x.example/any");
    await hooks.issueSession(context, "identity-1");
    const setCookieHeader = context.res.headers.get("set-cookie") ?? "";
    const raw = /oomol_connect_tenant_session=([^;]+)/.exec(setCookieHeader)?.[1];
    expect(raw).toBeTruthy();
    expect(await hooks.verifySessionCookie(raw as string)).toBe("identity-1");
    // A forged signature fails closed.
    expect(await hooks.verifySessionCookie(`${raw}.tampered`)).toBeUndefined();
    hooks.clearSession(await capturedContext(null, "https://x.example/any2"));
  });

  it("resolves admin, user_pat, disabled-identity PAT and session principals", async () => {
    // admin
    const adminContext = await capturedContext(null, "https://x.example/v1/health");
    const admin = await hooks.resolve(adminContext, true, undefined);
    expect(admin?.kind).toBe("admin");

    // user_pat on a registered identity
    const { identity } = await tenants.upsertIdentity({ issuer: jwks.issuer, subject: "pat-user" });
    const { record: pat } = await tokens.createToken("my-pat", emptyPolicy(), {
      kind: "user_pat",
      tenantId: identity.tenantId,
    });
    const patContext = await capturedContext(null, "https://x.example/mcp", { authorization: `Bearer ${pat.id}` });
    const principal = await hooks.resolve(patContext, false, {
      tokenId: pat.id,
      kind: "user_pat",
      tenantId: identity.tenantId,
    });
    expect(principal).toMatchObject({ kind: "user_pat", tenantId: identity.tenantId });

    // disabling the identity kills the PAT immediately
    await tenants.setIdentityDisabled(identity.id, true);
    const disabledPrincipal = await hooks.resolve(patContext, false, {
      tokenId: pat.id,
      kind: "user_pat",
      tenantId: identity.tenantId,
    });
    expect(disabledPrincipal).toBeUndefined();
    await tenants.setIdentityDisabled(identity.id, false);

    // session path: the cookie is minted on the login RESPONSE and travels on
    // subsequent REQUESTS.
    const loginContext = await capturedContext(null, "https://x.example/api/tenant/session");
    await hooks.issueSession(loginContext, identity.id);
    const cookieValue = /oomol_connect_tenant_session=([^;]+)/.exec(
      loginContext.res.headers.get("set-cookie") ?? "",
    )?.[1];
    expect(cookieValue).toBeTruthy();
    const sessionContext = await capturedContext(null, "https://x.example/v1/health", {
      cookie: `oomol_connect_tenant_session=${cookieValue}`,
    });
    const sessionPrincipal = await hooks.resolve(sessionContext, false, undefined);
    expect(sessionPrincipal).toMatchObject({ kind: "oidc_session", identityId: identity.id });
  });

  it("gates service_pat OBO by SERVICE_OBO and validates the actor identity", async () => {
    const consentHooks = await createTenantAuthHooks({
      config: {
        mode: "oidc",
        jwksUri: jwks.jwksUri,
        issuer: jwks.issuer,
        audience: jwks.audience,
        serviceObo: "consent",
      },
      tenantStore: tenants,
      sessionKey: { encryptionKey: "k" },
    });
    const offHooks = await createTenantAuthHooks({
      config: {
        mode: "oidc",
        jwksUri: jwks.jwksUri,
        issuer: jwks.issuer,
        audience: jwks.audience,
        serviceObo: "off",
      },
      tenantStore: tenants,
      sessionKey: { encryptionKey: "k" },
    });

    const { identity } = await tenants.upsertIdentity({ issuer: jwks.issuer, subject: "obo-user" });
    const { record: servicePat } = await tokens.createToken("facet-service", emptyPolicy(), { kind: "service_pat" });

    const ctx = (actor?: string) =>
      capturedContext(null, "https://x.example/mcp", actor ? { [actorHeaderName]: actor } : {});

    // off: even a valid actor is refused
    expect(
      await offHooks.resolve(await ctx("obo-user"), false, { tokenId: servicePat.id, kind: "service_pat" }),
    ).toBeUndefined();

    // consent gate: no consent row yet → refused; grant → allowed
    expect(
      await consentHooks.resolve(await ctx("obo-user"), false, { tokenId: servicePat.id, kind: "service_pat" }),
    ).toBeUndefined();
    await tenants.grantConsent(identity.tenantId, servicePat.id);
    const allowed = await consentHooks.resolve(await ctx("obo-user"), false, {
      tokenId: servicePat.id,
      kind: "service_pat",
    });
    expect(allowed).toMatchObject({
      kind: "service_pat",
      tenantId: identity.tenantId,
      actorTenantId: identity.tenantId,
    });

    // unknown actor sub → refused even in allow-all
    expect(
      await hooks.resolve(await ctx("nobody"), false, { tokenId: servicePat.id, kind: "service_pat" }),
    ).toBeUndefined();
    // no actor header → refused
    expect(await hooks.resolve(await ctx(), false, { tokenId: servicePat.id, kind: "service_pat" })).toBeUndefined();
    // user_pat carrying an actor header is not OBO material — resolver sees only the grant kind
    const userPat = await tokens.createToken("u", emptyPolicy(), { kind: "user_pat", tenantId: identity.tenantId });
    const oboAttempt = await hooks.resolve(await ctx("obo-user"), false, {
      tokenId: userPat.record.id,
      kind: "user_pat",
      tenantId: identity.tenantId,
    });
    expect(oboAttempt).toMatchObject({ kind: "user_pat", tenantId: identity.tenantId });
    expect(oboAttempt?.actorTenantId).toBeUndefined();
  });
});

describe("local auth middleware with tenant hooks", () => {
  it("accepts a minted PAT before revocation and 401s after", async () => {
    const server = await withJwksServer();
    const database = new SqliteRuntimeDatabase(":memory:");
    const tokens = new RuntimeTokenService(database.runtimeTokenStore);
    const tenants = database.tenantStore;
    const hooks = await createTenantAuthHooks({
      config: {
        mode: "oidc",
        jwksUri: server.jwksUri,
        issuer: server.issuer,
        audience: server.audience,
        serviceObo: "off",
      },
      tenantStore: tenants,
      sessionKey: { encryptionKey: "k" },
    });
    try {
      const app = new Hono();
      app.use("*", createLocalAuthMiddleware({ tenant: hooks, resolveRuntimeToken: (t) => tokens.resolveToken(t) }));
      app.get("/mcp", (c) => c.json({ ok: true }));

      const { identity } = await tenants.upsertIdentity({ issuer: server.issuer, subject: "mw-user" });
      const { token, record: pat } = await tokens.createToken("p", emptyPolicy(), {
        kind: "user_pat",
        tenantId: identity.tenantId,
      });

      const ok = await app.request("/mcp", { headers: { authorization: `Bearer ${token}` } });
      expect(ok.status).toBe(200);

      await tokens.revokeToken(pat.id);
      const revoked = await app.request("/mcp", { headers: { authorization: `Bearer ${token}` } });
      expect(revoked.status).toBe(401);

      const anon = await app.request("/mcp");
      expect(anon.status).toBe(401);
    } finally {
      await server.close();
      database.close();
    }
  });

  it("runs service_pat OBO as the actor tenant through the middleware", async () => {
    const server = await withJwksServer();
    const database = new SqliteRuntimeDatabase(":memory:");
    const tokens = new RuntimeTokenService(database.runtimeTokenStore);
    const tenants = database.tenantStore;
    const buildApp = async (serviceObo: "off" | "allow-all") => {
      const hooks = await createTenantAuthHooks({
        config: {
          mode: "oidc",
          jwksUri: server.jwksUri,
          issuer: server.issuer,
          audience: server.audience,
          serviceObo,
        },
        tenantStore: tenants,
        sessionKey: { encryptionKey: "k" },
      });
      const app = new Hono();
      app.use("*", createLocalAuthMiddleware({ tenant: hooks, resolveRuntimeToken: (t) => tokens.resolveToken(t) }));
      const seen: string[] = [];
      app.get("/v1/probe", async (c) => {
        const rows = await database.connectionStore.list();
        seen.push(currentStoreTenant());
        return c.json({ count: rows.length });
      });
      app.get("/api/providers", (c) => c.json({ ok: true }));
      return { app, seen };
    };
    try {
      const { identity } = await tenants.upsertIdentity({ issuer: server.issuer, subject: "obo-mw-user" });
      await database.connectionStore.set("github", "svc", credFor("obo"), identity.tenantId);
      const { token, record: servicePat } = await tokens.createToken("facet", emptyPolicy(), {
        kind: "service_pat",
      });
      const headers = { authorization: `Bearer ${token}`, [actorHeaderName]: "obo-mw-user" };

      const allowAll = await buildApp("allow-all");
      const ok = await allowAll.app.request("/v1/probe", { headers });
      expect(ok.status).toBe(200);
      expect(allowAll.seen[0]).toBe(identity.tenantId); // executes inside the actor's tenant
      await expect(ok.json()).resolves.toMatchObject({ count: 1 }); // and only sees that tenant's connections

      const noActor = await allowAll.app.request("/v1/probe", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(noActor.status).toBe(401);

      const unknownActor = await allowAll.app.request("/v1/probe", {
        headers: { authorization: `Bearer ${token}`, [actorHeaderName]: "nobody" },
      });
      expect(unknownActor.status).toBe(401);

      const adminScope = await allowAll.app.request("/api/providers", { headers });
      expect(adminScope.status).toBe(403);

      const off = await buildApp("off");
      const offRes = await off.app.request("/v1/probe", { headers });
      expect(offRes.status).toBe(401);

      await tokens.revokeToken(servicePat.id);
      const revoked = await allowAll.app.request("/v1/probe", { headers });
      expect(revoked.status).toBe(401);
    } finally {
      await server.close();
      database.close();
    }
  });
});

describe("request-context wiring", () => {
  it("scopes store defaults to the authenticated tenant through the middleware chain", async () => {
    const server = await withJwksServer();
    const database = new SqliteRuntimeDatabase(":memory:");
    const tenants = database.tenantStore;
    const tokens = new RuntimeTokenService(database.runtimeTokenStore);
    const hooks = await createTenantAuthHooks({
      config: {
        mode: "oidc",
        jwksUri: server.jwksUri,
        issuer: server.issuer,
        audience: server.audience,
        serviceObo: "off",
      },
      tenantStore: tenants,
      sessionKey: { encryptionKey: "k" },
    });
    const seen: { list: string[]; ctxTenant: string }[] = [];
    const app = new Hono();
    app.use("*", createLocalAuthMiddleware({ tenant: hooks, resolveRuntimeToken: (t) => tokens.resolveToken(t) }));
    app.get("/v1/probe", async (c) => {
      const rows = await database.connectionStore.list(); // context default in effect
      seen.push({ list: rows.map((r) => r.tenantId ?? ""), ctxTenant: currentStoreTenant() });
      return c.json({ count: rows.length });
    });

    const a = await tenants.upsertIdentity({ issuer: server.issuer, subject: "wire-a" });
    const b = await tenants.upsertIdentity({ issuer: server.issuer, subject: "wire-b" });
    const policy = { allowedActions: [], blockedActions: [], allowedProxies: [], allowedConnections: [] };
    await database.connectionStore.set("github", "one", credFor("a"), a.identity.tenantId);
    await database.connectionStore.set("github", "two", credFor("b"), b.identity.tenantId);

    const patA = await tokens.createToken("a", policy, { kind: "user_pat", tenantId: a.identity.tenantId });
    const res = await app.request("/v1/probe", { headers: { authorization: `Bearer ${patA.token}` } });
    expect(res.status).toBe(200);
    expect(seen[0].ctxTenant).toBe(a.identity.tenantId);
    expect(seen[0].list).toEqual([a.identity.tenantId]); // only tenant A's row

    await server.close();
    database.close();
  });
});

function credFor(tag: string) {
  return {
    authType: "api_key" as const,
    apiKey: `key-${tag}`,
    values: { apiKey: `key-${tag}` },
    profile: { accountId: tag, displayName: tag, grantedScopes: [] },
    metadata: { providerAccountVerified: false },
  };
}
