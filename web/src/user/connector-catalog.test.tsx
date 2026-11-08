// App directory (/me): the filtering rules, pinned.
//
// The wall is only as good as what it decides to show. These are the decisions
// a screenshot cannot prove: connected-first ordering, multi-category matching,
// the category facet list, and that an auth-free provider is offered as ready
// rather than as something to connect.

import { describe, expect, it } from "vitest";
import { catalogCategories, catalogEntries } from "./connector-catalog";

const providers = [
  { service: "alpha_vantage", displayName: "Alpha Vantage", authTypes: ["api_key"], categories: ["Finance", "Data"] },
  { service: "github", displayName: "GitHub", authTypes: ["api_key", "oauth2"], categories: ["Developer"] },
  { service: "plainrss", displayName: "Plain RSS", authTypes: [] as string[], categories: ["Data"] },
  { service: "kingdee", displayName: "Kingdee", authTypes: ["api_key"], categories: ["Finance"] },
];

const connections = [
  { service: "kingdee", configured: true },
  { service: "alpha_vantage", configured: false },
];

describe("catalogEntries", () => {
  it("puts connected services first and keeps the rest alphabetical", () => {
    const rows = catalogEntries(providers, connections);
    expect(rows.map((row) => row.provider.service)).toEqual(["kingdee", "alpha_vantage", "github", "plainrss"]);
    expect(rows[0].connected).toBe(1);
    // A row that exists but is not configured (a stale record) is not "connected".
    expect(rows.find((row) => row.provider.service === "alpha_vantage")?.connected).toBe(0);
  });

  it("matches a query against name, service id and category", () => {
    expect(catalogEntries(providers, connections, { query: "git" }).map((row) => row.provider.service)).toEqual([
      "github",
    ]);
    expect(catalogEntries(providers, connections, { query: "FINANCE" }).map((row) => row.provider.service)).toEqual([
      "kingdee",
      "alpha_vantage",
    ]);
    expect(
      catalogEntries(providers, connections, { query: "alpha_vantage" }).map((row) => row.provider.service),
    ).toEqual(["alpha_vantage"]);
  });

  it("filters by one category of a multi-category provider", () => {
    const rows = catalogEntries(providers, connections, { category: "Data" });
    expect(rows.map((row) => row.provider.service).sort()).toEqual(["alpha_vantage", "plainrss"]);
  });

  it("marks an auth-free provider as ready rather than as work to do", () => {
    const row = catalogEntries(providers, connections).find((entry) => entry.provider.service === "plainrss");
    expect(row?.authFree).toBe(true);
    const keyed = catalogEntries(providers, connections).find((entry) => entry.provider.service === "github");
    expect(keyed?.authFree).toBe(false);
  });
});

describe("catalogCategories", () => {
  it("counts providers per category, most populated first", () => {
    expect(catalogCategories(providers)).toEqual([
      { id: "Data", count: 2 },
      { id: "Finance", count: 2 },
      { id: "Developer", count: 1 },
    ]);
  });

  it("returns nothing for a catalog without categories", () => {
    expect(catalogCategories([{ service: "x", displayName: "X", authTypes: ["api_key"] }])).toEqual([]);
  });
});

// ── Rendered structure ──────────────────────────────────────────────────────
// The wall's contract in one render: a card per provider, the connected one says
// so, and the facets are the categories actually present.

import { I18n } from "@embra/i18n";
import { I18nProvider } from "@embra/i18n/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CatalogCard } from "./connector-catalog";

const catalogLocale = {
  en: {
    userCatalog: {
      title: "App directory",
      intro: "{{count}} services you can connect.",
      searchPlaceholder: "Search…",
      filterLabel: "Filter by category",
      all: "All",
      connect: "Connect",
      connected: "Connected · {{count}}",
      authFree: "No credential needed",
      empty: "Nothing matches that search.",
      matchCount: "{{count}} services",
      showMore: "Show {{count}} more",
    },
  },
};

function renderCatalog(): string {
  const i18n = new I18n("en", catalogLocale, { fallback: "en" });
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(CatalogCard, { providers, connections, onConnect: () => undefined }),
    ),
  );
}

describe("CatalogCard markup", () => {
  it("renders one card per service, grouped by the catalog's categories", () => {
    const markup = renderCatalog();
    expect(markup.match(/user-catalog-card"/g)?.length).toBe(4);
    expect(markup).toContain("Alpha Vantage");
    expect(markup).toContain("App directory");
    // Category facets are the categories present, with their counts.
    expect(markup).toContain(">Data<");
    expect(markup).toContain(">Finance<");
  });

  it("says which services are already connected and which need no credential", () => {
    const markup = renderCatalog();
    expect(markup).toContain("Connected · 1");
    expect(markup).toContain("No credential needed");
    // The un-connected, credential-bearing providers offer the connect verb.
    expect(markup).toContain("Connect");
  });
});
