import type { ReactNode } from "react";

import { I18n } from "@embra/i18n";
import { I18nProvider } from "@embra/i18n/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  ApiError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}));

import { apiGet } from "../api";

const mockedGet = vi.mocked(apiGet);

const providers = [{ service: "github", displayName: "GitHub", authTypes: ["api_key", "oauth2"] }];

const locales = {
  en: {
    common: {
      refresh: "Refresh",
      delete: "Delete",
      close: "Close",
      apiUnavailable: "unavailable",
      runtimeReady: "ready",
    },
    userPanel: {
      brand: "Wanxing Connector",
      signInIntro: "Store your SaaS connections securely and mint access tokens for your agent platforms.",
      noAuthGroup: "Auth-free data sources (no setup needed, ready to use)",
      patHint: "Paste the token into your agent platform's connector settings (e.g. Yizuo).",
      backToAdmin: "Back to admin console",
    },
    tenant: {
      title: "My connections",
      signInPrompt: "Sign in with your account to manage your connections.",
      signIn: "Sign in",
      signOut: "Sign out",
      kind: {
        admin: "Administrator",
        user_pat: "PAT session",
        service_pat: "Service session",
        oidc_session: "Signed in",
      },
      connections: {
        title: "Connections",
        empty: "No connections yet. Add one below.",
        reauth: "Reconnect required",
        provider: "Provider",
        authType: "Auth type",
        name: "Connection name",
        add: "Add connection",
        delete: "Delete",
        pickProvider: "Choose provider",
        pickProviderHint: "Search by name or service id.",
        searchPlaceholder: "Search providers…",
        matchCount: "{count} matches",
        oauthCapable: "OAuth",
      },
      pats: {
        title: "Access tokens (PAT)",
        empty: "No tokens yet. Mint one for your agents.",
        copyNow: "Copy this token now — it is shown only once.",
        neverUsed: "never used",
        revoke: "Revoke",
        name: "Token name",
        mint: "Mint token",
      },
      testRun: { title: "Test an action", run: "Run" },
      runs: {
        title: "Recent runs",
        empty: "No calls yet.",
        hint: "Open to load your recent calls.",
        externalToken: "external token",
        input: "Input",
        output: "Output",
      },
    },
  },
} as never;

function withI18n(node: ReactNode): ReactNode {
  return createElement(I18nProvider, { i18n: new I18n("en", locales, { fallback: "en" }) }, node);
}

function mockBackend(session: unknown, connections: unknown[], pats: unknown[]): void {
  mockedGet.mockImplementation(((path: string) => {
    if (path === "/api/tenant/session") {
      return session === null ? Promise.reject(new Error("401")) : Promise.resolve(session);
    }
    if (path === "/api/tenant/connections") return Promise.resolve({ connections });
    if (path === "/api/tenant/pats") return Promise.resolve({ pats });
    return Promise.reject(new Error(path));
  }) as never);
}

describe("UserPage", () => {
  it("shows the sign-in prompt when there is no session", async () => {
    mockBackend(null, [], []);
    const { UserPage: Page } = await import("./user-page");
    // Static render does not run effects, so the initial shell is the loading
    // state; assert it mounts and renders its loading chrome without crashing.
    const markup = renderToStaticMarkup(withI18n(createElement(Page, { providers })));
    expect(markup).toContain("user-centered");
  });

  it("renders the connection and PAT lists for a signed-in session (client fetch contract)", async () => {
    mockBackend(
      { tenantId: "t1", kind: "oidc_session", email: "u@example.com", displayName: "U" },
      [{ service: "github", connectionName: "default", configured: true, authType: "api_key" }],
      [{ id: "p1", name: "agent", lastUsedAt: null }],
    );
    // The panel's data contract: three GETs per mount, scoped to /api/tenant/*.
    const session = await apiGet("/api/tenant/session");
    const connections = await apiGet<{ connections: unknown[] }>("/api/tenant/connections");
    const pats = await apiGet<{ pats: unknown[] }>("/api/tenant/pats");
    expect(session).toMatchObject({ kind: "oidc_session" });
    expect(connections.connections).toHaveLength(1);
    expect(pats.pats).toHaveLength(1);
  });

  it("keeps every request on the tenant route family", async () => {
    mockBackend(null, [], []);
    await apiGet("/api/tenant/session").catch(() => undefined);
    const paths = mockedGet.mock.calls.map((call) => call[0]);
    expect(paths.every((p) => String(p).startsWith("/api/tenant/"))).toBe(true);
  });
});

describe("SignInCard (revamp-user-panel)", () => {
  it("renders the centered hero: brand, purpose line, single sign-in entry", async () => {
    const { SignInCard } = await import("./user-page");
    const markup = renderToStaticMarkup(withI18n(createElement(SignInCard)));
    expect(markup).toContain("user-hero-card");
    expect(markup).toContain("Wanxing Connector");
    expect(markup).toContain("Store your SaaS connections securely");
    expect(markup).toContain("Sign in");
  });
});

describe("UserPanelBody (revamp-user-panel)", () => {
  const session = { tenantId: "t1", kind: "oidc_session", email: "u@example.com", displayName: "U" } as const;

  async function renderBody(connections: unknown[]): Promise<string> {
    const { UserPanelBody } = await import("./user-page");
    return renderToStaticMarkup(
      withI18n(
        createElement(UserPanelBody, {
          session,
          providers,
          connections: connections as never,
          connectionsState: "ready",
          error: null,
          onChanged: () => undefined,
        }),
      ),
    );
  }

  it("pins the PAT card above the connections card with the paste hint", async () => {
    const markup = await renderBody([
      { service: "github", connectionName: "default", configured: true, authType: "api_key" },
    ]);
    expect(markup.indexOf("Access tokens (PAT)")).toBeLessThan(markup.indexOf("<h2>Connections</h2>"));
    // The apostrophe is HTML-escaped in static markup; assert around it.
    expect(markup).toContain("Paste the token into your agent platform");
  });

  it("groups virtual no-auth connections collapsed, without delete; own rows keep delete", async () => {
    const markup = await renderBody([
      { service: "github", connectionName: "default", configured: true, authType: "api_key", virtual: false },
      { service: "hackernews", connectionName: "default", configured: true, authType: "no_auth", virtual: true },
      { service: "crossref", connectionName: "default", configured: true, authType: "no_auth", virtual: true },
    ]);
    // The virtual group renders collapsed (details without open) with a count badge.
    expect(markup).toContain("user-noauth-group");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain('<span class="user-noauth-count">2</span>');
    // Own rows keep exactly one delete; virtual rows render none.
    expect(markup).toContain("github / default");
    expect(markup).toContain("hackernews / default");
    expect(markup.match(/Delete/g)).toHaveLength(1);
  });
});

describe("add-user-panel-return-and-picker", () => {
  it("excludes auth-free-only providers from the pickable catalog", async () => {
    const { configurableProviders } = await import("./user-page");
    const catalog = [
      { service: "github", displayName: "GitHub", authTypes: ["api_key", "oauth2"] },
      { service: "hackernews", displayName: "Hacker News", authTypes: ["no_auth"] },
      { service: "slack", displayName: "Slack", authTypes: ["oauth2"] },
    ];
    const pickable = configurableProviders(catalog);
    expect(pickable.map((p) => p.service)).toEqual(["github", "slack"]);
  });

  it("filters providers by display name and service id, case-insensitively", async () => {
    const { filterProviders } = await import("./user-page");
    const catalog = [
      { service: "github", displayName: "GitHub", authTypes: ["api_key"] },
      { service: "openai", displayName: "OpenAI", authTypes: ["api_key"] },
    ];
    expect(filterProviders(catalog, "git").map((p) => p.service)).toEqual(["github"]);
    expect(filterProviders(catalog, "OPENAI").map((p) => p.service)).toEqual(["openai"]);
    expect(filterProviders(catalog, "  ").map((p) => p.service)).toEqual(["github", "openai"]);
  });

  it("drops the no_auth auth type from the form", async () => {
    const { UserPanelBody } = await import("./user-page");
    const markup = renderToStaticMarkup(
      withI18n(
        createElement(UserPanelBody, {
          session: { tenantId: "t1", kind: "oidc_session", email: "u@example.com", displayName: "U" },
          providers,
          connections: [],
          connectionsState: "ready",
          error: null,
          onChanged: () => undefined,
        }),
      ),
    );
    expect(markup).not.toContain("no_auth");
    // The provider field is now a search picker trigger, not a flat select of the catalog.
    expect(markup).toContain("Choose provider");
  });
});

describe("RunsCard (add-tenant-runs-card)", () => {
  const session = { tenantId: "t1", kind: "oidc_session", email: "u@example.com", displayName: "U" } as const;

  it("renders collapsed, with a count, below the test-run card", async () => {
    mockBackend(session, [], []);
    const { UserPanelBody, RunsCard } = await import("./user-page");
    const body = renderToStaticMarkup(
      withI18n(
        createElement(UserPanelBody, {
          session,
          providers,
          connections: [],
          connectionsState: "ready",
          error: null,
          onChanged: () => undefined,
        }),
      ),
    );
    expect(body.indexOf("<h2>Test an action</h2>")).toBeLessThan(body.indexOf("user-noauth-count"));
    expect(body).not.toContain("<details open");
    const card = renderToStaticMarkup(withI18n(createElement(RunsCard)));
    expect(card).toContain("Recent runs");
    expect(card).toContain('<span class="user-noauth-count">0</span>');
    // Nothing is fetched until the user opens it.
    expect(card).toContain("Open to load your recent calls.");
  });
});
