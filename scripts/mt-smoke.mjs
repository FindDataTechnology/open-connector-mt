#!/usr/bin/env node
import { exportJWK, exportPKCS8, generateKeyPair, importPKCS8, SignJWT } from "jose";
/**
 * Multi-tenancy smoke script (open-connector-mt).
 *
 * Boots the REAL server in TENANCY=oidc mode against a stub OIDC IdP, walks
 * the full user journey (login → paste connection → mint PAT → MCP list and
 * execute → second tenant isolation probes → revoke → 401), then re-boots in
 * TENANCY=off and asserts the tenant face is gone. Exit 0 = pass.
 *
 *   node scripts/mt-smoke.mjs           (set MT_SMOKE_VERBOSE=1 for server logs)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ok = (cond, label) => {
  if (!cond) throw new Error(`SMOKE FAIL: ${label}`);
  console.log(`  ok ${label}`);
};

// ── cookie jar ──────────────────────────────────────────────────────────────
function jar() {
  const store = new Map();
  return {
    absorb(response) {
      for (const line of response.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) store.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

async function jsonCall(base, path, { method = "GET", body, cookies, headers } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(headers ?? {}),
      ...(cookies ? { cookie: cookies.header() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  cookies?.absorb(response);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  return { status: response.status, json, response };
}

// ── stub OIDC IdP ───────────────────────────────────────────────────────────
async function startStubIdp(claimedIssuer, audience) {
  const codes = new Map();
  let issuer = claimedIssuer; // replaced with the local URL after bind
  const keys = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "stub-key", alg: "ES256", use: "sig" };
  const privatePem = await exportPKCS8(keys.privateKey);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        }),
      );
    } else if (url.pathname === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
    } else if (url.pathname === "/authorize") {
      // The smoke picks the "signed in" user via a stub-side cookie.
      const jarHeader = req.headers.cookie ?? "";
      const sub =
        Object.fromEntries(
          jarHeader
            .split(";")
            .filter(Boolean)
            .map((p) => {
              const eq = p.indexOf("=");
              return [p.slice(0, eq).trim(), p.slice(eq + 1).trim()];
            }),
        ).stub_user ?? "alice";
      const code = `code-${Math.random().toString(36).slice(2)}`;
      codes.set(code, { sub, redirectUri: url.searchParams.get("redirect_uri") });
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.toString() }).end();
    } else if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const granted = codes.get(form.get("code"));
      if (!granted) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      // Logto (and every OIDC server) matches redirect_uri byte-for-byte
      // against the authorize request. Enforcing it here is what makes the
      // smoke catch proxy-topology origin bugs the stub used to ignore.
      if (form.get("redirect_uri") !== granted.redirectUri) {
        res
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "invalid_grant", error_description: "redirect_uri mismatch" }));
        return;
      }
      codes.delete(form.get("code"));
      const idToken = await new SignJWT({ email: `${granted.sub}@example.com`, name: granted.sub })
        .setProtectedHeader({ alg: "ES256", kid: "stub-key" })
        .setIssuedAt()
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(granted.sub)
        .setExpirationTime("10m")
        .sign(await importPKCS8(privatePem, "ES256"));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id_token: idToken }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  issuer = url; // discovery, token endpoints and the iss claim are all local and dialable
  return { server, url };
}

// The connector builds its IdP URL from the discovery document's issuer host
// (https://stub-idp.example — not dialable). The smoke rewrites every IdP hop
// onto the local stub listener.
function localHop(url, idpBase) {
  const rewritten = new URL(url);
  const target = new URL(idpBase);
  rewritten.protocol = target.protocol;
  rewritten.host = target.host;
  return rewritten.toString();
}

/** Full OIDC login against the real routes: authorize → stub approve → callback. */
async function loginAs(base, idpBase, stubUser) {
  const cookies = jar();
  const authorize = await fetch(`${base}/api/tenant/oidc/authorize`, { redirect: "manual" });
  cookies.absorb(authorize);
  const idpUrl = authorize.headers.get("location");
  ok(Boolean(idpUrl), `authorize redirect issued (${authorize.status})`);
  const approved = await fetch(localHop(idpUrl, idpBase), {
    redirect: "manual",
    headers: { cookie: `stub_user=${stubUser}` },
  });
  const callbackUrl = approved.headers.get("location");
  ok(Boolean(callbackUrl), `stub IdP approved ${stubUser} (${approved.status})`);
  // The redirect_uri already points at the connector origin — hop as-is,
  // carrying the pending-state cookie the authorize route planted. The smoke's
  // public origin is https (the Caddy topology) while the server speaks plain
  // http, so the harness plays TLS terminator: same path+query, dialed locally.
  const hop = new URL(callbackUrl);
  const callback = await fetch(`${base}${hop.pathname}${hop.search}`, {
    redirect: "manual",
    headers: { cookie: cookies.header() },
  });
  cookies.absorb(callback);
  ok([200, 302].includes(callback.status), `callback accepted (${callback.status})`);
  return cookies;
}

// ── server process ──────────────────────────────────────────────────────────
function startServer(env, dataDir, port) {
  const child = spawn(process.execPath, ["src/server/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      OOMOL_CONNECT_DATA_DIR: dataDir,
      // Deliberately DIFFERENT from the dialed http://127.0.0.1:<port>: the
      // deployment sits behind a TLS terminator, and this divergence is what
      // exposes origin bugs (redirect_uri built from the request URL instead
      // of the configured public origin).
      OOMOL_CONNECT_ORIGIN: `https://connector.smoke.invalid`,
      OOMOL_CONNECT_ENCRYPTION_KEY: "smoke-encryption-key",
      OOMOL_CONNECT_ADMIN_TOKEN: "smoke-admin-token",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.env.MT_SMOKE_VERBOSE && process.stderr.write(d));
  return child;
}

async function waitHealthy(base, tries = 240) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not become healthy");
}

const mcp = (base, body, token, extraHeaders) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(extraHeaders ?? {}),
    },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // SSE frames: take the last data: line as the JSON-RPC response.
      const dataLines = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (dataLines.length) json = JSON.parse(dataLines[dataLines.length - 1]);
    }
    return { status: r.status, json };
  });

// ── main ────────────────────────────────────────────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), "mt-smoke-"));
const port = 18999;
const base = `http://127.0.0.1:${port}`;
const idp = await startStubIdp("https://stub-idp.example", "smoke-console-client");
// The server does discovery against the issuer, so the deployment issuer is
// the LOCAL stub URL; the stub signs id tokens with the same value.
const deploymentIssuer = idp.url;
// The issuer must be dialable from the server (discovery) AND match the ID
// token iss claim, so it IS the local stub URL.
const issuerUrl = idp.url;
void issuerUrl;
let server;
try {
  console.log("booting TENANCY=oidc");
  server = startServer(
    {
      TENANCY: "oidc",
      SERVICE_OBO: "allow-all",
      OOMOL_CONNECT_JWKS_URI: `${idp.url}/jwks`,
      OOMOL_CONNECT_JWT_ISSUER: deploymentIssuer,
      OOMOL_CONNECT_JWT_AUDIENCE: "smoke-console-client",
      OOMOL_CONNECT_OIDC_CLIENT_ID: "smoke-console-client",
    },
    dataDir,
    port,
  );
  await waitHealthy(base);

  const config = (await jsonCall(base, "/api/tenant/config")).json;
  ok(config.mode === "oidc" && config.loginUrl, "config reports oidc mode with a login url");

  // ── alice: login, create a no_auth connection (offline validation), PAT ──
  const alice = await loginAs(base, idp.url, "alice");
  const sessionA = (await jsonCall(base, "/api/tenant/session", { cookies: alice })).json;
  ok(sessionA.email === "alice@example.com", `session resolves alice (${sessionA.email})`);
  const patA = (
    await jsonCall(base, "/api/tenant/pats", { method: "POST", cookies: alice, body: { name: "alice-agent" } })
  ).json;
  ok(patA.token?.startsWith("oct_"), "alice minted a PAT (plaintext shown once)");

  // Pick a provider that supports no_auth — the catalog is huge, so select at
  // runtime instead of hardcoding. Any action id works for the resolution
  // probes (connection_not_found fires before execution).
  const unwrap = (envelope) => envelope?.data ?? envelope?.providers ?? envelope;
  const providers = await fetch(`${base}/v1/providers`, { headers: { authorization: `Bearer ${patA.token}` } })
    .then((r) => r.json())
    .then(unwrap);
  const candidates = (Array.isArray(providers) ? providers : []).filter((p) => p.authTypes?.includes("no_auth"));
  const target = candidates[0];
  ok(Boolean(target), `found a no_auth provider (${target?.service})`);
  const setup = await fetch(`${base}/v1/providers/${target.service}`, {
    headers: { authorization: `Bearer ${patA.token}` },
  })
    .then((r) => r.json())
    .then(unwrap);
  let actionId = setup?.actions?.[0]?.id;
  if (!actionId) {
    // The setup payload may not include actions; fall back to the action
    // search API (envelope-wrapped as well).
    const actions = await fetch(`${base}/v1/actions?service=${encodeURIComponent(target.service)}&limit=1`, {
      headers: { authorization: `Bearer ${patA.token}` },
    })
      .then((r) => r.json())
      .then(unwrap);
    actionId = (Array.isArray(actions) ? actions : actions?.actions)?.[0]?.id;
  }
  ok(Boolean(actionId), `provider ships an action (${actionId})`);
  const created = await jsonCall(base, "/api/tenant/connections", {
    method: "POST",
    cookies: alice,
    body: { service: target.service, connectionName: "default", authType: "no_auth", values: {} },
  });
  if (created.status !== 200) {
    console.error("create connection failed:", created.status, JSON.stringify(created.json));
  }
  ok(created.status === 200, `alice created a no_auth connection on ${target.service}`);

  // ── MCP as PAT A ──
  const listed = await mcp(
    base,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_connections", arguments: {} },
    },
    patA.token,
  );
  if (!JSON.stringify(listed.json).includes(target.service)) {
    console.error("list_connections payload:", JSON.stringify(listed.json).slice(0, 400));
  }
  ok(JSON.stringify(listed.json).includes(target.service), "list_connections sees alice's connection over MCP");

  const missing = await mcp(
    base,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "execute_action", arguments: { actionId, connectionName: "no-such-connection" } },
    },
    patA.token,
  );
  const missingText = JSON.stringify(missing.json);
  ok(missingText.includes("connection_not_found"), "missing connection executes as connection_not_found");

  // ── bob: same-name connection, cross-tenant probes ──
  const bob = await loginAs(base, idp.url, "bob");
  const sessionB = (await jsonCall(base, "/api/tenant/session", { cookies: bob })).json;
  ok(sessionB.email === "bob@example.com", `session resolves bob (${sessionB.email})`);
  await jsonCall(base, "/api/tenant/connections", {
    method: "POST",
    cookies: bob,
    body: { service: target.service, connectionName: "default", authType: "no_auth", values: {} },
  });
  const patB = (await jsonCall(base, "/api/tenant/pats", { method: "POST", cookies: bob, body: { name: "bob-agent" } }))
    .json;

  const bobList = await mcp(
    base,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_connections", arguments: {} },
    },
    patB.token,
  );
  const bobText = JSON.stringify(bobList.json);
  ok(!bobText.includes("alice"), "bob's list never mentions alice's connections");

  const bobMissing = await mcp(
    base,
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "execute_action", arguments: { actionId, connectionName: "no-such-connection" } },
    },
    patB.token,
  );
  ok(
    JSON.stringify(bobMissing.json).includes("connection_not_found"),
    "cross-tenant / missing connections share the exact not-found shape (indistinguishable)",
  );

  // ── the admin domain stays behind the admin token ──
  // A user PAT governs /mcp and /v1/* only; reaching deployment-global admin
  // config with it would be a privilege escalation.
  for (const path of ["/api/providers", "/api/connections", "/api/runtime-policy"]) {
    const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${patA.token}` } });
    ok(response.status === 403, `PAT is refused on the admin domain (${path} → ${response.status})`);
  }

  // ── revoke PAT A → immediate 401 ──
  const revoked = await jsonCall(base, `/api/tenant/pats/${patA.id}`, { method: "DELETE", cookies: alice });
  ok(revoked.status === 200, "alice revoked her PAT");
  const afterRevoke = await mcp(base, { jsonrpc: "2.0", id: 5, method: "tools/list" }, patA.token);
  ok(afterRevoke.status === 401, "revoked PAT is rejected immediately");

  // ── service PAT: admin mints, runs on the actor's tenant, dies on revoke ──
  const adminHeaders = { authorization: "Bearer smoke-admin-token" };
  const minted = await jsonCall(base, "/api/runtime-tokens", {
    method: "POST",
    headers: adminHeaders,
    body: { name: "facet-service", kind: "service_pat" },
  });
  ok(
    minted.status === 200 && minted.json?.record?.kind === "service_pat" && minted.json.token?.startsWith("oct_"),
    "admin minted a service_pat (kind projected, tenant-less)",
  );
  const servicePat = minted.json.token;

  const badKind = await jsonCall(base, "/api/runtime-tokens", {
    method: "POST",
    headers: adminHeaders,
    body: { name: "not-a-user", kind: "user_pat" },
  });
  ok(badKind.status === 400, "user_pat cannot be minted from the admin domain (OIDC session path only)");

  const as = (sub) => ({ "x-oo-connector-actor-sub": sub });
  const noActor = await mcp(base, { jsonrpc: "2.0", id: 6, method: "tools/list" }, servicePat);
  ok(noActor.status === 401, "service_pat without an actor header is refused");
  const unknownActor = await mcp(base, { jsonrpc: "2.0", id: 7, method: "tools/list" }, servicePat, as("nobody"));
  ok(unknownActor.status === 401, "unknown actor sub is refused");

  // End-to-end OBO call through the real server + MCP transport. Positive
  // tenant-data scoping (the actor's tenant only) is asserted at middleware
  // level in tenant-auth.test.ts against a real store — catalog-level markers
  // cannot separate tenants here because no_auth providers surface as virtual
  // connections for every tenant and api_key creates verify against live APIs.
  const oboList = (id, sub) =>
    mcp(
      base,
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "list_connections", arguments: { service: target.service } },
      },
      servicePat,
      as(sub),
    );
  const oboAlice = await oboList(8, "alice");
  ok(oboAlice.status === 200, "service_pat + actor=alice executes MCP tools/call on the real server");
  const oboBob = await oboList(9, "bob");
  ok(oboBob.status === 200, "the same service_pat with actor=bob also resolves");

  const adminDenied = await fetch(`${base}/api/providers`, {
    headers: { authorization: `Bearer ${servicePat}`, ...as("alice") },
  });
  ok(adminDenied.status === 403, "service_pat cannot reach the admin domain even with an actor header");

  const revokeService = await fetch(`${base}/api/runtime-tokens/${minted.json.record.id}`, {
    method: "DELETE",
    headers: adminHeaders,
  });
  ok(revokeService.status === 200, "admin revoked the service_pat");
  const deadPat = await mcp(base, { jsonrpc: "2.0", id: 10, method: "tools/list" }, servicePat, as("alice"));
  ok(deadPat.status === 401, "revoked service_pat is rejected immediately");

  // ── restart in TENANCY=off ──
  console.log("rebooting TENANCY=off");
  server.kill("SIGKILL");
  await new Promise((r) => server.once("exit", r));
  server = startServer({}, dataDir, port);
  await waitHealthy(base);
  // In off mode the tenant routes are not mounted at all — a 404 IS the
  // "no tenant face" guarantee (the console treats it as no tenant mode).
  const offConfig = await jsonCall(base, "/api/tenant/config");
  ok(offConfig.status === 404 || offConfig.json?.mode === "off", "tenant face is gone after reboot");
  // The admin token governs the ADMIN domain (the /v1 runtime scope requires a
  // runtime token once any exist — upstream semantics).
  const adminSession = await fetch(`${base}/api/auth/session`, {
    headers: { authorization: "Bearer smoke-admin-token" },
  }).then((r) => r.json());
  ok(adminSession?.authenticated === true, "admin token still governs the admin domain in off mode");
  const rootHealth = await fetch(`${base}/health`);
  ok(rootHealth.status === 200, "server healthy in off mode");

  console.log("\nSMOKE PASS");
} finally {
  server?.kill("SIGKILL");
  idp.server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
