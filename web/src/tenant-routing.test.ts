import type { ReactNode } from "react";

import { I18n } from "@embra/i18n";
import { I18nProvider } from "@embra/i18n/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
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
  apiPut: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

let tenantMode: "off" | "oidc" = "oidc";

vi.mock("./user/use-tenant-config", () => ({
  useTenantConfig: () => ({ mode: tenantMode, issuer: null, clientId: null, localeDefault: null, loginUrl: null }),
}));

import { apiGet } from "./api";
import { App } from "./ui";

const mockedGet = vi.mocked(apiGet);

const locales = {
  en: {
    common: { loadingRuntimeData: "Loading…", refresh: "Refresh", delete: "Delete", close: "Close" },
    brand: { console: "Open Connector" },
    nav: { overview: "Overview", me: "My connections" },
    shell: { logout: "Log out" },
    tenant: {},
  },
} as never;

function renderApp(path: string): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n: new I18n("en", locales, { fallback: "en" }) },
      createElement(MemoryRouter, { initialEntries: [path] }, createElement(App)),
    ),
  );
}

/** The admin dashboard load fails (locked console); /me must still render. */
function failingAdminBackend(): void {
  mockedGet.mockImplementation(((path: string) => {
    if (path === "/api/tenant/config") return Promise.resolve({ mode: tenantMode });
    return Promise.reject(new Error("401"));
  }) as never);
}

describe("console tenant routing (open-connector-mt)", () => {
  it("renders the user panel on /me without the admin unlock wall", () => {
    tenantMode = "oidc";
    failingAdminBackend();
    const markup = renderApp("/me");
    expect(markup).toContain("user-shell-main");
    expect(markup).not.toContain("unlock-screen");
  });

  it("keeps the admin unlock wall on other routes", () => {
    tenantMode = "oidc";
    failingAdminBackend();
    const markup = renderApp("/overview");
    expect(markup).toContain("unlock-screen");
  });

  it("hides the user panel entirely when tenancy is off", () => {
    tenantMode = "off";
    failingAdminBackend();
    const markup = renderApp("/me");
    expect(markup).not.toContain("user-shell-main");
    expect(markup).toContain("unlock-screen");
    tenantMode = "oidc";
  });
});

// Keep the file a module with JSX-free types only.
export type { ReactNode };
