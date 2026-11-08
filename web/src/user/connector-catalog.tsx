// App directory for the tenant console (/me).
//
// The console could already connect a provider, but only through a search box
// inside the connections card: you had to know the name of the thing you wanted.
// The catalog is the browse side of the same act — one card per connectable
// provider, icon first, grouped by the catalog's own categories — and a card
// click is the same code path the picker runs (it hands the service back to the
// connection form). No second connect implementation lives here on purpose.

import type { ProviderOption } from "./user-page";

import { useTranslate } from "@embra/i18n/react";
import { Check, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { ProviderIcon } from "../shared-ui";

/** Cards rendered before the "show everything" affordance. */
export const catalogPageSize = 60;

export interface CatalogEntry {
  provider: ProviderOption;
  /** Connections this tenant already has for the service. */
  connected: number;
  /** True when the provider needs no credential at all (auth-free sources). */
  authFree: boolean;
}

/**
 * One flat list, filtered by query and category. Categories come from the
 * catalog as plain strings; a provider with several categories appears once and
 * matches any of them.
 */
export function catalogEntries(
  providers: ProviderOption[],
  connections: { service: string; configured?: boolean; virtual?: boolean }[],
  options: { query?: string; category?: string | null } = {},
): CatalogEntry[] {
  const query = (options.query ?? "").trim().toLowerCase();
  const category = options.category ?? null;
  const counts = new Map<string, number>();
  for (const connection of connections) {
    if (connection.configured === false) continue;
    counts.set(connection.service, (counts.get(connection.service) ?? 0) + 1);
  }
  const rows: CatalogEntry[] = [];
  for (const provider of providers) {
    const categories = provider.categories ?? [];
    if (category && !categories.includes(category)) continue;
    if (
      query &&
      !provider.displayName.toLowerCase().includes(query) &&
      !provider.service.toLowerCase().includes(query) &&
      !categories.some((value) => value.toLowerCase().includes(query))
    ) {
      continue;
    }
    rows.push({
      provider,
      connected: counts.get(provider.service) ?? 0,
      authFree: provider.authTypes.length === 0,
    });
  }
  return rows.sort((a, b) => {
    // Connected first, then unconfigured catalog order — the wall doubles as
    // "what do I already have".
    if (a.connected !== b.connected) return b.connected - a.connected;
    return a.provider.displayName.localeCompare(b.provider.displayName);
  });
}

/** Categories present in the given providers, most populated first. */
export function catalogCategories(providers: ProviderOption[]): { id: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const provider of providers) {
    for (const category of provider.categories ?? []) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

export function CatalogCard(props: {
  providers: ProviderOption[];
  connections: { service: string; configured?: boolean; virtual?: boolean }[];
  onConnect: (service: string) => void;
}): React.ReactNode {
  const t = useTranslate();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Auth-free providers are listed too: they need no credential, so "connect"
  // is meaningless, but they are the data sources an agent can use today and
  // hiding them behind the collapsed group made the catalog look emptier than
  // the runtime is.
  const connectable = useMemo(
    () =>
      props.providers.filter(
        (p) => p.authTypes.some((type) => type === "api_key" || type === "oauth2") || p.authTypes.length === 0,
      ),
    [props.providers],
  );
  const categories = useMemo(() => catalogCategories(connectable), [connectable]);
  const rows = useMemo(
    () => catalogEntries(connectable, props.connections, { query, category }),
    [connectable, props.connections, query, category],
  );
  const shown = expanded ? rows : rows.slice(0, catalogPageSize);

  return (
    <section className="user-card" id="catalog">
      <div className="user-catalog-head">
        <h2>{t("userCatalog.title")}</h2>
        <p className="user-catalog-intro">{t("userCatalog.intro", { count: connectable.length })}</p>
      </div>

      <div className="user-catalog-controls">
        <label className="user-catalog-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setExpanded(false);
            }}
            placeholder={t("userCatalog.searchPlaceholder")}
            aria-label={t("userCatalog.searchPlaceholder")}
          />
        </label>
        {rows.length !== shown.length || expanded ? (
          <span className="user-catalog-count">{t("userCatalog.matchCount", { count: rows.length })}</span>
        ) : null}
      </div>

      {categories.length > 0 ? (
        <div className="user-catalog-facets" role="group" aria-label={t("userCatalog.filterLabel")}>
          <button
            type="button"
            className={category === null ? "user-catalog-chip active" : "user-catalog-chip"}
            aria-pressed={category === null}
            onClick={() => {
              setCategory(null);
              setExpanded(false);
            }}
          >
            {t("userCatalog.all")}
          </button>
          {categories.slice(0, 12).map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={category === entry.id ? "user-catalog-chip active" : "user-catalog-chip"}
              aria-pressed={category === entry.id}
              onClick={() => {
                setCategory(entry.id === category ? null : entry.id);
                setExpanded(false);
              }}
            >
              {entry.id}
              <span className="user-catalog-chip-count">{entry.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="user-catalog-empty">{t("userCatalog.empty")}</p>
      ) : (
        <div className="user-catalog-grid">
          {shown.map((entry) => {
            const label = entry.authFree
              ? t("userCatalog.authFree")
              : entry.connected > 0
                ? t("userCatalog.connected", { count: entry.connected })
                : t("userCatalog.connect");
            return (
              <button
                type="button"
                key={entry.provider.service}
                className="user-catalog-card"
                data-connected={entry.connected > 0 ? "1" : "0"}
                onClick={() => props.onConnect(entry.provider.service)}
              >
                <ProviderIcon provider={entry.provider} />
                <span className="user-catalog-card-copy">
                  <span className="user-catalog-card-title">{entry.provider.displayName}</span>
                  <span className="user-catalog-card-meta">
                    {entry.provider.categories?.[0] ?? entry.provider.service}
                  </span>
                </span>
                <span className={entry.connected > 0 ? "user-catalog-state is-connected" : "user-catalog-state"}>
                  {entry.connected > 0 ? <Check size={12} aria-hidden="true" /> : null}
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {!expanded && rows.length > shown.length ? (
        <button type="button" className="user-catalog-more" onClick={() => setExpanded(true)}>
          {t("userCatalog.showMore", { count: rows.length - shown.length })}
        </button>
      ) : null}
    </section>
  );
}
