import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService } from "../../connection-service.ts";
import type { ActionPolicySnapshot, OperationScope, TokenPolicy } from "../../core/action-policy.ts";
import type { OAuthFlowService } from "../../oauth/oauth-flow-service.ts";
import type { RunLog } from "../storage/runtime-store.ts";
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
import { hasAdminBearer, readRuntimeGrant, readTenantPrincipal } from "../api/auth.ts";
import { jsonError, readJsonBody } from "../api/http-utils.ts";
import { policyRequestMaxBytes, readTokenPolicy } from "../api/policy-input.ts";
import { BOOTSTRAP_TENANT_ID, PLATFORM_TENANT_ID } from "./constants.ts";
import { currentStoreTenant, runWithTenant } from "./request-context.ts";
import { readSessionCookieName } from "./tenant-auth.ts";

const oidcStateCookie = "oomol_connect_oidc_pending";
const oidcPendingMaxAgeSeconds = 600;

export interface TenantRouteOptions {
  /**
   * OIDC hooks. Present in TENANCY=oidc only; absent in TENANCY=off, where the
   * console runs against the bootstrap tenant and the admin bearer is the
   * authority (scoped PATs must mint the same way in both modes).
   */
  hooks?: TenantAuthHooks;
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
    /** Recent run logs; the tenant route scopes them before they reach the panel. */
    listRuns(input: { tenantId: string; limit: number }): Promise<{ items: RunLogSource[] }>;
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
  const hooks = options.hooks;
  if (hooks) {
    const cookie = context.req.header("cookie") ?? "";
    const match = new RegExp(`(?:^|;\\s*)${readSessionCookieName()}=([^;]+)`).exec(cookie);
    if (match) {
      const identityId = await hooks.verifySessionCookie(decodeURIComponent(match[1]));
      if (identityId) {
        const identity = await options.tenants.getIdentityById(identityId);
        if (identity && !identity.disabledAt) {
          return { tenantId: identity.tenantId, kind: "oidc_session", identityId: identity.id };
        }
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
  // The deployment's admin credential is the owner of the bootstrap tenant, and
  // TENANCY=off has no other authority (no OIDC hooks, no tenant layer). Both
  // modes admit it here so scoped-PAT minting and revocation stay reachable.
  if (hasAdminBearer(context)) {
    return { tenantId: BOOTSTRAP_TENANT_ID, kind: "admin" };
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
  const { config } = options;
  const hooks = options.hooks;
  const oidcEnabled = config.mode === "oidc" && !!hooks;

  // ── Cross-mint CORS helpers (add-connector-account-picker) ──────────────
  // Exact-match origin allowlist (OOMOL_CONNECT_CROSS_MINT_ORIGINS). Only an
  // allowlisted Origin gets CORS response headers — a non-allowlisted caller
  // gets 403 with no ACAO header, so the browser blocks the read. Every
  // response carries Vary: Origin so caches never serve one origin's CORS
  // verdict to another.
  const crossMintAllowed = (origin: string | undefined): origin is string =>
    !!origin && (config.crossMintOrigins ?? []).includes(origin.replace(/\/+$/, ""));

  const applyCrossMintCors = (context: Context, origin: string): void => {
    context.header("Access-Control-Allow-Origin", origin);
    context.header("Access-Control-Allow-Credentials", "true");
    context.header("Vary", "Origin");
  };

  // D8: when the deployment turns on cross-site session cookies, every
  // cookie-carrying mutating /api/tenant/* request must present an Origin that
  // is same-origin or cross-mint-allowlisted — SameSite=None would otherwise
  // let attacker pages blind-POST/DELETE with the victim's cookie. Browsers
  // always send Origin on non-GET/HEAD, so enforcement keys on the session
  // cookie being present: bearer-only callers (PAT/admin, e.g. the platform
  // backend revoking a PAT) carry no cookie and are never blocked.
  if (config.crossSiteCookie ?? false) {
    app.use("/api/tenant/*", async (context, next) => {
      if (["GET", "HEAD", "OPTIONS"].includes(context.req.method)) return next();
      const cookieName = readSessionCookieName();
      const hasSessionCookie = new RegExp(`(?:^|;\\s*)${cookieName}=`).test(context.req.header("cookie") ?? "");
      if (!hasSessionCookie) return next();
      const origin = context.req.header("origin");
      const publicOrigin = options.publicOrigin?.replace(/\/+$/, "");
      if (origin && (origin.replace(/\/+$/, "") === publicOrigin || crossMintAllowed(origin))) return next();
      return jsonError(context, 403, "origin_not_allowed", "Mutating tenant requests require a known origin.");
    });
  }

  // Deployment facts the console needs before login. No secrets.
  app.get("/api/tenant/config", (context) =>
    context.json({
      mode: config.mode,
      issuer: config.issuer ?? null,
      clientId: config.clientId ?? null,
      localeDefault: config.localeDefault ?? null,
      loginUrl: oidcEnabled ? "/api/tenant/oidc/authorize" : null,
    }),
  );

  // ── OIDC login (public client, PKCE, discovery-driven token endpoint) ────
  app.get("/api/tenant/oidc/authorize", async (context) => {
    if (!config.issuer || !config.clientId || !oidcEnabled) {
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
    if (!hooks || !config.issuer || !config.clientId) {
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
    hooks?.clearSession(context);
    return context.json({ ok: true });
  });

  // Everything below requires a signed-in principal.
  app.use("/api/tenant/*", async (context, next) => {
    const path = context.req.path;
    if (
      path === "/api/tenant/config" ||
      path === "/api/tenant/oidc/authorize" ||
      path === "/api/tenant/oidc/callback" ||
      // cross-mint owns its Origin + session checks and must answer with CORS
      // headers on 401 too (the browser reads the status to poll the flow);
      // this middleware's bare 401 would short-circuit before those headers.
      path === "/api/tenant/cross-mint" ||
      path === "/api/tenant/cross-mint/probe"
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

  // ── PATs (scoped-pat-grants) ────────────────────────────────────────────
  // The PAT is the only connector credential the consumer side ever holds, so
  // the mint is where scope is decided: `allowedActions` / `allowedConnections`
  // narrow the token to the binding it serves. Both lists are *checked* here —
  // a rule no catalog action can satisfy, or a connection this tenant does not
  // own, is rejected outright instead of being silently trimmed (a trimmed
  // scope would look successful and then deny at execution time).
  //
  // Omitted lists keep the upstream meaning: an empty allowlist is unrestricted
  // (the full-authority PAT that already exists). Only an attenuated mint
  // inherits its parent's lists instead — see below.
  app.get("/api/tenant/pats", async (context) => {
    const principal = await requireUser(context, options);
    if (!principal) return jsonError(context, 403, "forbidden", "PATs belong to signed-in identities.");
    const all = await options.runtimeTokens.listTokens();
    return context.json({
      pats: all
        .filter((token) => token.kind === "user_pat" && token.tenantId === principal.tenantId)
        .map((token) => ({
          id: token.id,
          name: token.name,
          purpose: token.purpose ?? null,
          lastUsedAt: token.lastUsedAt ?? null,
          allowedActions: token.allowedActions,
          allowedConnections: token.allowedConnections,
          allowedOperations: token.allowedOperations ?? [],
          parentTokenId: token.parentTokenId ?? null,
        })),
    });
  });

  app.post("/api/tenant/pats", async (context) => {
    const principal = await requireUser(context, options);
    if (!principal) {
      return jsonError(
        context,
        403,
        "forbidden",
        "Sign in with OIDC, or present a PAT or the admin token, to mint PATs.",
      );
    }
    if (principal.kind === "service_pat") {
      // A service token acts for someone else; letting it mint would hand out
      // credentials the service itself never owns.
      return jsonError(context, 403, "forbidden", "Service tokens cannot mint PATs.");
    }
    const body = await readJsonBody(context, policyRequestMaxBytes);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "pat";
    const purpose = typeof body.purpose === "string" ? body.purpose.trim() || undefined : undefined;
    const requested = readTokenPolicy(body, true);
    if (
      requested.blockedActions.length > 0 ||
      requested.allowedProxies.length > 0 ||
      (requested.allowedTriggers ?? []).length > 0
    ) {
      return jsonError(
        context,
        400,
        "invalid_scope",
        "PAT scope accepts only allowedActions, allowedOperations and allowedConnections.",
      );
    }

    const tenantId = principal.tenantId;
    let policy: TokenPolicy = requested;
    let parentTokenId: string | undefined;
    if (principal.kind === "user_pat") {
      // Attenuation: a PAT may derive a narrower PAT for itself. Desktop and
      // headless callers have no browser session, so without this path the only
      // way to hand a binding its own credential would be to paste a full PAT.
      if (!purpose) {
        return jsonError(context, 400, "purpose_required", "Attenuated PATs must state a purpose.");
      }
      const parent = readRuntimeGrant(context);
      if (!parent?.tokenId) {
        return jsonError(context, 403, "forbidden", "The calling token could not be resolved.");
      }
      parentTokenId = parent.tokenId;
      const parentActions = parent.allowedActions ?? [];
      const parentOperations = parent.allowedOperations ?? [];
      const parentConnections = parent.allowedConnections ?? [];
      const requestedConnections = requested.allowedConnections ?? [];
      const requestedOperations = requested.allowedOperations ?? [];
      // Both allowlists (action rules and class scopes) are empty ⇒ the child
      // stated no action scope at all, so it inherits the parent's whole scope.
      // Stating either one is a narrowing intent: the omitted one stays empty
      // rather than silently inheriting the parent's wider list.
      const scopeStated = requested.allowedActions.length > 0 || requestedOperations.length > 0;
      const childActions = scopeStated ? requested.allowedActions : parentActions;
      const childOperations = scopeStated ? requestedOperations : parentOperations;
      const childConnections = requestedConnections.length > 0 ? requestedConnections : parentConnections;
      const overreach = childActions.filter(
        (rule) => !actionRuleWithinParentScope(rule, parentActions, parentOperations, options.catalog),
      );
      if (overreach.length > 0) {
        return jsonError(
          context,
          403,
          "scope_not_attenuated",
          `Requested scope exceeds the calling token: ${overreach.join(", ")}`,
        );
      }
      const overreachOperations = childOperations.filter(
        (scope) => !operationWithinParentScope(scope, parentActions, parentOperations),
      );
      if (overreachOperations.length > 0) {
        return jsonError(
          context,
          403,
          "scope_not_attenuated",
          `Requested scope exceeds the calling token: ${overreachOperations.map(operationLabel).join(", ")}`,
        );
      }
      if (parentConnections.length > 0) {
        const outside = childConnections.filter((id) => !parentConnections.includes(id));
        if (outside.length > 0) {
          return jsonError(
            context,
            403,
            "scope_not_attenuated",
            `Requested connections exceed the calling token: ${outside.join(", ")}`,
          );
        }
      }
      // Blocks/proxies/triggers are not part of the request; inherit the
      // parent's so the child's effective policy can only be narrower.
      policy = {
        allowedActions: childActions,
        blockedActions: parent.blockedActions ?? [],
        allowedProxies: parent.allowedProxies ?? [],
        allowedConnections: childConnections,
        allowedTriggers: parent.allowedTriggers ?? [],
        allowedOperations: childOperations,
      };
    }

    // Satisfiability: a scope the catalog cannot honour is a typo, not a narrow
    // grant, and a connection id from another tenant must look like a plain
    // unknown id (no existence oracle).
    const unsatisfiable = unsatisfiableActionRules(policy.allowedActions, options.catalog);
    if (unsatisfiable.length > 0) {
      return jsonError(context, 400, "invalid_scope", `No catalog action matches: ${unsatisfiable.join(", ")}`);
    }
    const unsatisfiableOperations = unsatisfiableOperationScopes(policy.allowedOperations ?? [], options.catalog);
    if (unsatisfiableOperations.length > 0) {
      return jsonError(
        context,
        400,
        "invalid_scope",
        `No catalog action matches: ${unsatisfiableOperations.map(operationLabel).join(", ")}`,
      );
    }
    const unknownConnections = await unknownConnectionIds(options, policy.allowedConnections ?? []);
    if (unknownConnections.length > 0) {
      return jsonError(context, 400, "invalid_scope", `Unknown connections: ${unknownConnections.join(", ")}`);
    }

    // Same-name re-mint: union and revoke the replaced token. Bindings re-mint
    // on every grant extension, so this keeps one live token per name with a
    // scope that only widens (narrowing is a deliberate revoke + re-mint).
    // v1 tenancy is one identity per tenant, so (tenant, name, parent) is the
    // identity's PAT name space.
    const siblings = (
      await options.runtimeTokens.listTokens().catch(() => [] as Awaited<ReturnType<RuntimeTokenService["listTokens"]>>)
    ).filter(
      (token) =>
        token.kind === "user_pat" &&
        token.tenantId === tenantId &&
        token.name === name &&
        (token.parentTokenId ?? undefined) === parentTokenId,
    );
    const merged: TokenPolicy = siblings.reduce(
      (acc, token) => ({
        ...acc,
        allowedActions: unique([...acc.allowedActions, ...token.allowedActions]),
        allowedConnections: unique([...(acc.allowedConnections ?? []), ...token.allowedConnections]),
        allowedOperations: uniqueOperationScopes([
          ...(acc.allowedOperations ?? []),
          ...(token.allowedOperations ?? []),
        ]),
      }),
      policy,
    );
    for (const replaced of siblings) {
      // Not cascading: the replacement keeps the union, so anything derived from
      // the replaced token is still inside its parent's (unchanged or wider) scope.
      await options.runtimeTokens.revokeToken(replaced.id, { cascade: false });
    }

    const created = await options.runtimeTokens.createToken(name, merged, {
      kind: "user_pat",
      tenantId,
      purpose,
      parentTokenId,
    });
    // The plaintext is shown exactly once, in this response.
    return context.json({ token: created.token, id: created.record.id, name: created.record.name });
  });

  app.delete("/api/tenant/pats/:id", async (context) => {
    const principal = await requireUser(context, options);
    if (!principal) return jsonError(context, 403, "forbidden", "PATs belong to signed-in identities.");
    const id = context.req.param("id");
    const record = await options.runtimeTokens.listTokens().then((rows) => rows.find((row) => row.id === id));
    if (!record || record.kind !== "user_pat" || record.tenantId !== principal.tenantId) {
      // Cross-tenant ids answer exactly like missing ones.
      return jsonError(context, 404, "runtime_token_not_found", `PAT not found: ${id}`);
    }
    // Cascades: a derived token must not outlive the credential it came from.
    await options.runtimeTokens.revokeToken(id);
    await options.tenants.revokeConsentsForToken(id);
    return context.json({ id, revoked: true });
  });

  // ── Scope introspection (read-only; scoped-pat-grants D2) ───────────────
  // The consumer needs two facts it cannot derive on its own: why a call was
  // denied (so it can render "grant this"), and whether the catalog can honour
  // a binding's declared surface at all. The catalog lives only here, so these
  // two endpoints are the contract instead of letting the consumer copy it.
  // Neither executes an action, writes a run, or mutates a token.
  app.get("/api/tenant/scope-explain", async (context) => {
    const principal = await requireUser(context, options);
    if (!principal) return jsonError(context, 401, "unauthorized", "Sign in required.");
    const actionId = context.req.query("actionId")?.trim();
    if (!actionId) return jsonError(context, 400, "invalid_input", "actionId is required.");
    const action = options.catalog.actionsById.get(actionId);
    // Unknown and denied must be distinguishable: a typo must not render an
    // authorization card.
    if (!action) return jsonError(context, 404, "unknown_action", `Unknown action: ${actionId}`);
    const decision = (await options.policyOf(context)).evaluate(action);
    return context.json({
      actionId: action.id,
      provider: action.service,
      operationType: action.operationType,
      allowed: decision.allowed,
      code: decision.allowed ? null : decision.code,
      checks: decision.checks,
    });
  });

  app.get("/api/tenant/catalog-coverage", async (context) => {
    const principal = await requireUser(context, options);
    if (!principal) return jsonError(context, 401, "unauthorized", "Sign in required.");
    const providerId = context.req.query("provider")?.trim();
    if (!providerId) return jsonError(context, 400, "invalid_input", "provider is required.");
    const provider = options.catalog.providers.find((row) => row.service === providerId);
    if (!provider) return jsonError(context, 404, "unknown_provider", `Unknown provider: ${providerId}`);
    const requested = readOperationTypes(context.req.query("operations"));
    if (!requested) {
      return jsonError(
        context,
        400,
        "invalid_input",
        "operations must be a comma-separated subset of: read,write,destructive.",
      );
    }
    const operations = requested.map((operation) => {
      const actions = provider.actions.filter((action) => action.operationType === operation);
      const executableActionCount = actions.filter((action) => action.execution.locallyExecutable).length;
      return {
        operation,
        covered: executableActionCount > 0,
        actionCount: actions.length,
        executableActionCount,
      };
    });
    return context.json({
      provider: provider.service,
      operations,
      gaps: operations.filter((row) => !row.covered).map((row) => row.operation),
    });
  });

  // ── Cross-mint (add-connector-account-picker) ───────────────────────────
  // A companion platform (壹座) mints a fresh PAT on behalf of a signed-in
  // user, so the user never copies a token by hand. Mint-only: no listing, no
  // reading back existing tokens, no mutation of anything but the new PAT.
  // Routes exist only when the deployment configured an origin allowlist.
  if ((config.crossMintOrigins ?? []).length > 0) {
    const crossMintPreflight = (context: Context): Response => {
      const origin = context.req.header("origin");
      if (!crossMintAllowed(origin)) {
        return jsonError(context, 403, "origin_not_allowed", "Origin is not allowed to cross-mint.");
      }
      applyCrossMintCors(context, origin);
      context.header("Access-Control-Allow-Methods", "GET, POST");
      context.header("Access-Control-Allow-Headers", "content-type");
      return context.body(null, 204);
    };

    app.options("/api/tenant/cross-mint/probe", crossMintPreflight);
    app.options("/api/tenant/cross-mint", crossMintPreflight);

    app.get("/api/tenant/cross-mint/probe", async (context) => {
      const origin = context.req.header("origin");
      if (!crossMintAllowed(origin)) {
        return jsonError(context, 403, "origin_not_allowed", "Origin is not allowed to cross-mint.");
      }
      applyCrossMintCors(context, origin);
      const principal = await requireUser(context, options);
      if (!principal?.identityId) return jsonError(context, 401, "unauthorized", "Not signed in.");
      const identity = await options.tenants.getIdentityById(principal.identityId);
      if (!identity) return jsonError(context, 404, "identity_not_found", "Identity not found.");
      // The caller's own login identity — same facts /me shows, no secrets.
      return context.json({ email: identity.email ?? null, displayName: identity.displayName ?? null });
    });

    app.post("/api/tenant/cross-mint", async (context) => {
      const origin = context.req.header("origin");
      if (!crossMintAllowed(origin)) {
        return jsonError(context, 403, "origin_not_allowed", "Origin is not allowed to cross-mint.");
      }
      applyCrossMintCors(context, origin);
      const principal = await requireUser(context, options);
      if (!principal?.identityId) return jsonError(context, 401, "unauthorized", "Not signed in.");
      const identity = await options.tenants.getIdentityById(principal.identityId);
      if (!identity) return jsonError(context, 404, "identity_not_found", "Identity not found.");
      const body = (await context.req.json().catch(() => ({}))) as { name?: string };
      const name = body.name?.trim() || "cross-mint";
      const created = await options.runtimeTokens.createToken(name, emptyPolicy(), {
        kind: "user_pat",
        tenantId: identity.tenantId,
      });
      // The plaintext is shown exactly once, in this response. Nothing about
      // the caller's existing tokens comes back — mint-only.
      return context.json({ token: created.token, id: created.record.id, name: created.record.name });
    });
  }

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

  // ── Run logs (tenant-scoped, projected) ─────────────────────────────────
  app.get("/api/tenant/runs", async (context) => {
    const principal = await requireUser(context, options);
    if (!principal) return jsonError(context, 401, "unauthorized", "Sign in required.");
    // Admin principals keep the cross-tenant view upstream gives them; everyone
    // else is pinned to their own tenant, which is also what runWithTenant set
    // as the store default — so an OBO run lands in the actor's tenant.
    const tenantId = principal.kind === "admin" ? currentStoreTenant() : principal.tenantId;
    if (!tenantId) return jsonError(context, 403, "forbidden", "Tenant scope unavailable.");
    const limit = clampRunLimit(context.req.query("limit"));
    const page = await options.actions.listRuns({ tenantId, limit });
    const patNames = await mapPatNames(options, tenantId);
    return context.json({
      runs: page.items.map((run) => projectRun(run, patNames)),
    });
  });

  // PLATFORM_TENANT_ID is referenced for OAuth client config resolution order
  // (tenant row wins, platform row is the fallback); kept imported so the
  // resolution contract is visible next to the routes that rely on it.
  void PLATFORM_TENANT_ID;
}

/** What the tenant panel is allowed to learn about a run — nothing internal. */
export interface TenantRunView {
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
  patName: string;
}

/** The subset of RunLog the tenant route reads. */
export type RunLogSource = RunLog;

export function projectRun(run: RunLogSource, patNames: Map<string, string>): TenantRunView {
  const startedAt = run.startedAt;
  const completedAt = run.completedAt;
  const durationMs =
    startedAt && completedAt ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()) : 0;
  return {
    id: run.id,
    startedAt,
    durationMs,
    ok: run.ok,
    service: run.service,
    actionId: run.actionId,
    caller: run.caller,
    connectionName: run.connectionProfile?.displayName ?? run.connectionId,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    inputSummary: run.inputSummary,
    outputSummary: run.outputSummary,
    patName: patNames.get(run.runtimeTokenId ?? "") ?? "",
  };
}

/**
 * PAT id → name for this tenant. OBO runs carry the *service's* token, which is
 * never in this tenant's list — those fall back to the neutral placeholder the
 * UI fills in, so the panel can't distinguish (or leak) why a token is unknown.
 */
async function mapPatNames(options: TenantRouteOptions, tenantId: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const tokens = await options.runtimeTokens.listTokens();
    for (const token of tokens) {
      const record = token as { id?: string; name?: string; kind?: string; tenantId?: string };
      if (!record.id || !record.name) continue;
      if (record.kind === "user_pat" && record.tenantId && record.tenantId !== tenantId) continue;
      names.set(record.id, record.name);
    }
  } catch {
    // Unmapped tokens just render the placeholder.
  }
  return names;
}

function clampRunLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(Math.max(parsed, 1), 20);
}

function emptyPolicy() {
  return { allowedActions: [], blockedActions: [], allowedProxies: [], allowedConnections: [] };
}

/**
 * Rule matching that mirrors `compileActionRule` in core/action-policy.ts: `*`
 * matches everything, `service.*` is a prefix match on the literal rule minus
 * the star, anything else is an exact action id. Duplicating four lines keeps
 * this module from importing (and thereby being tempted to change) the policy
 * compiler, whose semantics are upstream.
 */
function actionIdMatchesRule(rule: string, actionId: string): boolean {
  if (rule === "*") return true;
  if (rule.endsWith(".*")) return actionId.startsWith(rule.slice(0, -1));
  return actionId === rule;
}

/** Whether a requested rule stays inside the parent allowlist (empty = unrestricted). */
function ruleWithinScope(parentRules: readonly string[], rule: string): boolean {
  if (parentRules.length === 0) return true;
  return parentRules.some((parentRule) => actionIdMatchesRule(parentRule, rule));
}

/**
 * Action-id prefixes present in the catalog, built once per immutable catalog.
 * A prefix keeps its trailing dot (`"kingdee."`), matching the compiler's
 * `startsWith(rule.slice(0, -1))` test exactly.
 */
const catalogActionPrefixes = new WeakMap<CatalogStore, Set<string>>();

function catalogPrefixes(catalog: CatalogStore): Set<string> {
  const cached = catalogActionPrefixes.get(catalog);
  if (cached) return cached;
  const prefixes = new Set<string>();
  for (const action of catalog.actions) {
    for (let at = action.id.indexOf("."); at > 0; at = action.id.indexOf(".", at + 1)) {
      prefixes.add(action.id.slice(0, at + 1));
    }
  }
  catalogActionPrefixes.set(catalog, prefixes);
  return prefixes;
}

/** Rules that can never match a catalog action — a typo, not a narrow grant. */
function unsatisfiableActionRules(rules: readonly string[], catalog: CatalogStore): string[] {
  const missing: string[] = [];
  let prefixes: Set<string> | undefined;
  for (const rule of rules) {
    if (rule === "*") continue;
    if (rule.endsWith(".*")) {
      prefixes ??= catalogPrefixes(catalog);
      if (!prefixes.has(rule.slice(0, -1))) missing.push(rule);
    } else if (!catalog.actionsById.has(rule)) {
      missing.push(rule);
    }
  }
  return missing;
}

/** Connection ids this tenant does not own; other tenants' ids look the same as missing ones. */
async function unknownConnectionIds(options: TenantRouteOptions, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const known = new Set((await options.connections.listConnections()).map((connection) => connection.id));
  return ids.filter((id) => !known.has(id));
}

const operationTypes = ["read", "write", "destructive"] as const;

/** `operations=read,write` query parsing; defaults to the read/write pair. Undefined = invalid. */
function readOperationTypes(raw: string | undefined): (typeof operationTypes)[number][] | undefined {
  const requested = (raw ?? "read,write")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const valid = requested.filter((value): value is (typeof operationTypes)[number] =>
    (operationTypes as readonly string[]).includes(value),
  );
  if (valid.length !== requested.length || valid.length === 0) return undefined;
  return unique(valid);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Canonical text form of an operation scope, the same string the policy `checks` carry. */
function operationLabel(scope: OperationScope): string {
  return `${scope.provider}@${scope.operationType}`;
}

function uniqueOperationScopes(scopes: readonly OperationScope[]): OperationScope[] {
  const seen = new Set<string>();
  const unique: OperationScope[] = [];
  for (const scope of scopes) {
    const label = operationLabel(scope);
    if (seen.has(label)) continue;
    seen.add(label);
    unique.push(scope);
  }
  return unique;
}

/** Whether a parent's class scopes include this exact `(provider, operationType)`. */
function coversOperation(scopes: readonly OperationScope[], provider: string, operationType: string): boolean {
  return scopes.some((scope) => scope.provider === provider && scope.operationType === operationType);
}

/**
 * Every `(provider, operationType)` pair the catalog can actually produce.
 * Cached per catalog so per-operation satisfiability checks stay O(1) instead of
 * scanning the provider list for each requested scope.
 */
const catalogOperationClasses = new WeakMap<CatalogStore, Set<string>>();

function catalogClasses(catalog: CatalogStore): Set<string> {
  const cached = catalogOperationClasses.get(catalog);
  if (cached) return cached;
  const classes = new Set<string>();
  for (const action of catalog.actions) {
    classes.add(`${action.service}@${action.operationType}`);
  }
  catalogOperationClasses.set(catalog, classes);
  return classes;
}

/** Scopes no catalog action can satisfy — an unknown provider or an empty class. */
function unsatisfiableOperationScopes(scopes: readonly OperationScope[], catalog: CatalogStore): OperationScope[] {
  if (scopes.length === 0) return [];
  const classes = catalogClasses(catalog);
  return scopes.filter((scope) => !classes.has(operationLabel(scope)));
}

/**
 * Whether an action rule the child requests is still inside the parent's scope,
 * where that scope may be expressed as rules, as class tuples, or both.
 *
 * A rule the parent covers by tuple must select *only* actions inside those
 * tuples: `kingdee.*` against a parent holding `(kingdee, read)` is a widening,
 * because the rule also selects write and destructive actions.
 */
function actionRuleWithinParentScope(
  rule: string,
  parentActions: readonly string[],
  parentOperations: readonly OperationScope[],
  catalog: CatalogStore,
): boolean {
  if (parentActions.length === 0 && parentOperations.length === 0) return true;
  if (parentActions.length > 0 && ruleWithinScope(parentActions, rule)) return true;
  if (parentOperations.length === 0) return false;
  const selected = actionsSelectedByRule(rule, catalog);
  if (!selected) return false;
  return selected.every((action) => coversOperation(parentOperations, action.service, action.operationType));
}

/** The catalog actions a rule selects, or undefined when the rule itself is unknown. */
function actionsSelectedByRule(
  rule: string,
  catalog: CatalogStore,
): readonly { service: string; operationType: string }[] | undefined {
  if (rule === "*") return catalog.actions;
  if (rule.endsWith(".*")) {
    const provider = rule.slice(0, -2);
    const match = catalog.providers.find((row) => row.service === provider);
    return match?.actions;
  }
  const action = catalog.actionsById.get(rule);
  return action ? [action] : undefined;
}

/**
 * Whether a class scope the child requests is inside the parent's scope. A
 * parent action rule covers a whole class only when it is `*` or `provider.*`:
 * an exact-id rule cannot stand in for every action of one class.
 */
function operationWithinParentScope(
  scope: OperationScope,
  parentActions: readonly string[],
  parentOperations: readonly OperationScope[],
): boolean {
  if (parentActions.length === 0 && parentOperations.length === 0) return true;
  if (coversOperation(parentOperations, scope.provider, scope.operationType)) return true;
  return parentActions.some((rule) => rule === "*" || rule === `${scope.provider}.*`);
}
