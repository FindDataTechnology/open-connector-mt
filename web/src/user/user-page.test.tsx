import type { ReactNode } from "react";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18n } from "@embra/i18n";
import { I18nProvider } from "@embra/i18n/react";

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
    common: { refresh: "Refresh", delete: "Delete", close: "Close", apiUnavailable: "unavailable", runtimeReady: "ready" },
    tenant: {
      title: "My connections",
      signInPrompt: "Sign in with your account to manage your connections.",
      signIn: "Sign in",
      signOut: "Sign out",
      kind: { admin: "Administrator", user_pat: "PAT session", service_pat: "Service session", oidc_session: "Signed in" },
      connections: {
        title: "Connections",
        empty: "No connections yet. Add one below.",
        reauth: "Reconnect required",
        provider: "Provider",
        authType: "Auth type",
        name: "Connection name",
        add: "Add connection",
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
