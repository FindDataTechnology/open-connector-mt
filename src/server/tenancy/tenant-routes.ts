import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService } from "../../connection-service.ts";
import type { ActionPolicySnapshot } from "../../core/action-policy.ts";
import type { OAuthFlowService } from "../../oauth/oauth-flow-service.ts";
import type { RuntimeTokenService } from "../storage/runtime-token-service.ts";
import type { ITenantStore } from "../storage/tenant-store.ts";
import type { TenancyConfig } from "./constants.ts";
import type { TenantAuthHooks } from "./tenant-auth.ts";
import type { Context } from "hono";

/**
 * Tenant-facing console routes (open-connector-mt).
 *
 * Mounted under /api/tenant/* (a public path family in the local auth
 * middleware): these routes authenticate via the OIDC session cookie (or a
 * user PAT / admin bearer), never via the upstream admin cookie. All storage
 * access runs inside runWithTenant so connections/PATs are scoped to the
 * caller's tenant by the data layer.
 */
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { readTenantPrincipal } from "../api/auth.ts";
import { jsonError } from "../api/http-utils.ts";
import { PLATFORM_TENANT_ID } from "./constants.ts";
import { currentStoreTenant, runWithTenant } from "./request-context.ts";
import { readSessionCookieName } from "./tenant-auth.ts";

const oidcStateCookie = "oomol_connect_oidc_pending";
const oidcPendingMaxAgeSeconds = 600;

export interface TenantRouteOptions {
  hooks: TenantAuthHooks;
  config: TenancyConfig;
  tenants: ITenantStore;
  runtimeTokens: RuntimeTokenService;
  oauthFlow: OAuthFlowService;
  connections: ConnectionService;
  catalog: CatalogStore;
  /** Test-run executor: the same ActionRunner the runtime API uses, with the policy snapshot bound. */
  actions: {
    run(
      input: {
        actionId: string;
        input: unknown;
        caller: "web";
        connectionName?: string;
        signal?: AbortSignal;
      },
      policy: ActionPolicySnapshot,
    ): Promise<unknown>;
  };
  /** The runtime's merged policy snapshot for the test-run. */
  policyOf(context: Context): Promise<ActionPolicySnapshot>;
  /** Public origin for redirect_uri construction (OOMOL_CONNECT_ORIGIN); falls back to the request origin. */
  publicOrigin?: string;
  logger?: { info(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void };
}

interface RequestPrincipal {
  tenantId: string;
  kind: string;
  identityId?: string;
  tokenId?: string;
}

async function requireUser(context: Context, options: TenantRouteOptions): Promise<RequestPrincipal | undefined> {
  // Session cookie first, then PAT/admin bearer via the shared hook resolver.
  const cookie = context.req.header("cookie") ?? "";
  const match = new RegExp(`(?:^|;\\s*)${readSessionCookieName()}=([^;]+)`).exec(cookie);
  if (match) {
    const identityId = await options.hooks.verifySessionCookie(decodeURIComponent(match[1]));
    if (identityId) {
      const identity = await options.tenants.getIdentityById(identityId);
      if (identity && !identity.disabledAt) {
        return { tenantId: identity.tenantId, kind: "oidc_session", identityId: identity.id };
      }
    }
  }
  const principal = readTenantPrincipal(context as never);
  if (principal) {
    return {
      tenantId: principal.tenantId,
      kind: principal.kind,
      identityId: principal.identityId,
      tokenId: principal.tokenId,
    };
  }
  return undefined;
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function readB64urlJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

export function registerTenantRoutes(app: Hono, options: TenantRouteOptions): void {
  const { hooks, config } = options;

  // Deployment facts the console needs before login. No secrets.
  app.get("/api/tenant/config", (context) =>
    context.json({
      mode: config.mode,
      issuer: config.issuer ?? null,
      clientId: config.clientId ?? null,
      localeDefault: config.localeDefault ?? null,
      loginUrl: config.mode === "oidc" ? "/api/tenant/oidc/authorize" : null,
    }),
  );

  // ── OIDC login (public client, PKCE, discovery-driven token endpoint) ────
  app.get("/api/tenant/oidc/authorize", async (context) => {
    if (!config.issuer || !config.clientId) {
      return jsonError(context, 503, "tenant_oidc_unconfigured", "OIDC login is not configured.");
    }
    const discovery = await fetch(new URL(`${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`), {
      signal: AbortSignal.timeout(8000),
    }).catch((e) => {
      options.logger?.warn({ err: String(e) }, "tenant oidc discovery fetch threw");
      return undefined;
    });
    if (!discovery?.ok) {
      options.logger?.warn({ status: discovery?.status }, "tenant oidc discovery failed");
      return jsonError(
        context,
        502,
        "tenant_oidc_discovery",
        `OIDC discovery failed (status ${discovery?.status ?? "fetch-error"}).`,
      );
    }
    const doc = (await discovery.json()) as { authorization_endpoint?: string };
    if (!doc.authorization_endpoint) {
      return jsonError(context, 502, "tenant_oidc_discovery", "OIDC discovery has no authorization endpoint.");
    }
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString(
      "base64url",
    );
    const state = crypto.randomUUID();
    // Behind TLS-terminating proxies context.req.url reads http; the deployed
    // origin is authoritative for redirect_uri matching.
    const origin = options.publicOrigin || new URL(context.req.url).origin;
    const redirectUri = `${origin}/api/tenant/oidc/callback`;
    const pending = b64urlJson({ verifier, state });
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    setCookie(context, oidcStateCookie, pending, {
      httpOnly: true,
      maxAge: oidcPendingMaxAgeSeconds,
      sameSite: "Lax",
      secure: origin.startsWith("https://"),
      path: "/",
    });
    return context.redirect(url.toString());
  });

  app.get("/api/tenant/oidc/callback", async (context) => {
    if (!config.issuer || !config.clientId) {
      return jsonError(context, 503, "tenant_oidc_unconfigured", "OIDC login is not configured.");
    }
    const raw = context.req.header("cookie") ?? "";
    const pendingRaw = new RegExp(`(?:^|;\\s*)${oidcStateCookie}=([^;]+)`).exec(raw)?.[1];
    if (!pendingRaw) return jsonError(context, 400, "invalid_oauth_state", "Login session expired, try again.");
    const pending = readB64urlJson<{ verifier: string; state: string }>(decodeURIComponent(pendingRaw));
    const url = new URL(context.req.url);
    if (url.searchParams.get("state") !== pending.state) {
      return jsonError(context, 400, "invalid_oauth_state", "OIDC state mismatch.");
    }
    const code = url.searchParams.get("code");
    if (!code) return jsonError(context, 400, "invalid_oauth_state", "Missing authorization code.");

    const discovery = await fetch(
      new URL(`${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`),
    ).catch((e) => {
      options.logger?.warn({ err: String(e) }, "tenant oidc callback discovery fetch threw");
      return undefined;
    });
    const doc = discovery?.ok ? ((await discovery.json()) as { token_endpoint?: string }) : undefined;
    if (!doc?.token_endpoint) {
      options.logger?.warn({ status: discovery?.status }, "tenant oidc callback discovery failed");
      return jsonError(
        context,
        502,
        "tenant_oidc_discovery",
        `OIDC discovery failed (status ${discovery?.status ?? "fetch-error"}).`,
      );
    }
    // Same public-origin rule as the authorize route: the IdP matches
    // redirect_uri byte-for-byte against the authorize request, so the
    // exchange must send the identical https value, not the proxy-local http.
    const origin = options.publicOrigin || new URL(context.req.url).origin;
    const tokenResponse = await fetch(doc.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${origin}/api/tenant/oidc/callback`,
        client_id: config.clientId,
        code_verifier: pending.verifier,
      }),
    });
    if (!tokenResponse.ok) {
      const detail = (await tokenResponse.text().catch(() => "")).slice(0, 300);
      options.logger?.warn({ status: tokenResponse.status, detail }, "tenant oidc code exchange failed");
      return jsonError(
        context,
        401,
        "tenant_oidc_exchange",
        `OIDC code exchange failed (${tokenResponse.status}): ${detail}`,
      );
    }
    const tokens = (await tokenResponse.json()) as { id_token?: string };
    if (!tokens.id_token) return jsonError(context, 401, "tenant_oidc_exchange", "No ID token returned.");
    const verified = await hooks.verifyIdToken(tokens.id_token);
    if (!verified) return jsonError(context, 401, "invalid_id_token", "ID token failed verification.");

    const { identity } = await options.tenants.upsertIdentity({
      issuer: verified.issuer,
      subject: verified.subject,
      email: verified.email,
      displayName: verified.displayName,
    });
    await hooks.issueSession(context, identity.id);
    // deleteCookie appends a second Set-Cookie; context.header() would clobber
    // the session cookie set above.
    deleteCookie(context, oidcStateCookie, { httpOnly: true, sameSite: "Lax", path: "/" });
    // End users have no admin token, so the admin console would show them the
    // unlock wall; the user panel is the destination that belongs to them.
    return context.redirect("/me");
  });

  // ── Session ─────────────────────────────────────────────────────────────
  app.get("/api/tenant/session", async (context) => {
    const principal = await requireUser(context, options);
    if (!principal) return jsonError(context, 401, "unauthorized", "Not signed in.");
    const identity = principal.identityId ? await options.tenants.getIdentityById(principal.identityId) : undefined;
    return context.json({
      tenantId: principal.tenantId,
      kind: principal.kind,
      email: identity?.email ?? null,
      displayName: identity?.displayName ?? null,
    });
  });

  app.post("/api/tenant/logout", (context) => {
    hooks.clearSession(context);
    return context.json({ ok: true });
  });

  // Everything below requires a signed-in principal.
  app.use("/api/tenant/*", async (context, next) => {
    const path = context.req.path;
    if (
      path === "/api/tenant/config" ||
      path === "/api/tenant/oidc/authorize" ||
      path === "/api/tenant/oidc/callback"
    ) {
      await next();
      return;
    }
    const principal = await requireUser(context, options);
    if (!principal) return jsonError(context, 401, "unauthorized", "Sign in required.");
    // Admin principals keep their cross-tenant view; tenant principals are scoped.
    if (principal.kind === "admin") {
      await next();
      return;
    }
    return runWithTenant(
      { tenantId: principal.tenantId, identityId: principal.identityId, serviceTokenId: principal.tokenId },
      next,
    );
  });

  // ── Connections (tenant-scoped via the request context) ─────────────────
  app.get("/api/tenant/connections", async (context) => {
    const rows = await options.connections.listConnections();
    return context.json({ connections: rows });
  });

  app.post("/api/tenant/connections", async (context) => {
    const body = (await context.req.json().catch(() => undefined)) as
      | { service?: string; connectionName?: string; authType?: string; values?: Record<string, string> }
      | undefined;
    if (!body?.service || !body.authType) {
      return jsonError(context, 400, "invalid_input", "service and authType are required.");
    }
    const input = { connectionName: body.connectionName, values: body.values ?? {} };
    try {
      // The store defaults to the request-context tenant, so these land on the
      // caller's tenant while keeping the upstream validation chain intact.
      const summary =
        body.authType === "api_key"
          ? await options.connections.connectWithApiKey(body.service, input)
          : body.authType === "custom_credential"
            ? await options.connections.connectWithCustomCredential(body.service, input)
            : body.authType === "no_auth"
              ? await options.connections.connectWithoutAuth(body.service, input)
              : undefined;
      if (!summary) {
        return jsonError(context, 400, "invalid_input", `Unsupported auth type: ${body.authType}`);
      }
      options.logger?.info({ service: body.service, tenantId: currentStoreTenant() }, "tenant connection created");
      return context.json(summary);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "invalid_input";
      return jsonError(context, code === "unknown_service" ? 404 : 400, code, (error as Error).message);
    }
  });

  app.delete("/api/tenant/connections/:service/:name", async (context) => {
    try {
      const summary = await options.connections.disconnect(context.req.param("service"), context.req.param("name"));
      return context.json(summary);
    } catch (error) {
      return jsonError(context, 400, (error as { code?: string }).code ?? "invalid_input", (error as Error).message);
    }
  });

  // ── OAuth connections (state row carries the tenant; 4.2 binding) ────────
  app.post("/api/tenant/oauth/:service/start", async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as { connectionName?: string };
    try {
      const authorization = await options.oauthFlow.startAuthorization({
        service: context.req.param("service"),
        connectionName: body.connectionName,
        tenantId: currentStoreTenant(),
      });
      return context.json(authorization);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "invalid_input";
      return jsonError(context, code === "unknown_service" ? 404 : 400, code, (error as Error).message);
    }
  });

  // ── PATs ────────────────────────────────────────────────────────────────
  app.get("/api/tenant/pats", async (context) => {
    const identityId = (await requireUser(context, options))?.identityId;
    if (!identityId) return jsonError(context, 403, "forbidden", "PATs belong to signed-in identities.");
    const identity = await options.tenants.getIdentityById(identityId);
    if (!identity) return jsonError(context, 404, "identity_not_found", "Identity not found.");
    const all = await options.runtimeTokens.listTokens();
    return context.json({
      pats: all
        .filter((t) => t.kind === "user_pat")
        .map((t) => ({
          id: (t as { id: string }).id,
          name: (t as { name: string }).name,
          lastUsedAt: (t as { lastUsedAt?: string }).lastUsedAt ?? null,
        })),
    });
  });

  app.post("/api/tenant/pats", async (context) => {
    const principal = await requireUser(context, options);
    if (!principal?.identityId) return jsonError(context, 403, "forbidden", "Sign in with OIDC to mint PATs.");
    const identity = await options.tenants.getIdentityById(principal.identityId);
    if (!identity) return jsonError(context, 404, "identity_not_found", "Identity not found.");
    const body = (await context.req.json().catch(() => ({}))) as { name?: string };
    const name = body.name?.trim() || "pat";
    const created = await options.runtimeTokens.createToken(name, emptyPolicy(), {
      kind: "user_pat",
      tenantId: identity.tenantId,
    });
    // The plaintext is shown exactly once, in this response.
    return context.json({ token: created.token, id: created.record.id, name: created.record.name });
  });

  app.delete("/api/tenant/pats/:id", async (context) => {
    const id = context.req.param("id");
    const record = await options.runtimeTokens
      .listTokens()
      .then((rows) => rows.find((r) => (r as { id: string }).id === id));
    if (!record) return jsonError(context, 404, "runtime_token_not_found", `PAT not found: ${id}`);
    if ((record as { kind?: string }).kind !== "user_pat") {
      return jsonError(context, 403, "forbidden", "Only user PATs are revocable here.");
    }
    const tenantId = (record as { tenantId?: string }).tenantId;
    if (tenantId && tenantId !== currentStoreTenant()) {
      return jsonError(context, 404, "runtime_token_not_found", `PAT not found: ${id}`);
    }
    await options.runtimeTokens.revokeToken(id);
    await options.tenants.revokeConsentsForToken(id);
    return context.json({ id, revoked: true });
  });

  // ── Action test-run (same runner as the runtime API) ────────────────────
  app.post("/api/tenant/actions/test", async (context) => {
    const body = (await context.req.json().catch(() => undefined)) as
      | { actionId?: string; input?: unknown; connectionName?: string }
      | undefined;
    if (!body?.actionId) return jsonError(context, 400, "invalid_input", "actionId is required.");
    const run = (await options.actions.run(
      {
        actionId: body.actionId,
        input: body.input ?? {},
        caller: "web",
        connectionName: body.connectionName,
      },
      await options.policyOf(context),
    )) as { ok?: boolean; output?: unknown; errorCode?: string; errorMessage?: string } | undefined;
    if (!run) return jsonError(context, 404, "unknown_action", `Unknown action: ${body.actionId}`);
    return context.json(run);
  });

  // PLATFORM_TENANT_ID is referenced for OAuth client config resolution order
  // (tenant row wins, platform row is the fallback); kept imported so the
  // resolution contract is visible next to the routes that rely on it.
  void PLATFORM_TENANT_ID;
}

function emptyPolicy() {
  return { allowedActions: [], blockedActions: [], allowedProxies: [], allowedConnections: [] };
}
