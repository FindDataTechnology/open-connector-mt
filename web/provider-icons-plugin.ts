import type { Plugin } from "vite";

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const catalogUrl = "https://connector.oomol.com/public/v1/apps";
const publicModuleId = "virtual:oomol-provider-icons";
const resolvedModuleId = `\0${publicModuleId}`;

interface CatalogItem {
  iconUrl?: unknown;
  service?: unknown;
}

interface CatalogPayload {
  data?: unknown;
}

interface ProviderIconsPluginOptions {
  iconUrls?: Readonly<Record<string, string>>;
  /**
   * Download every mapped icon into `<localDir>/` and point the map at those
   * files instead of the upstream CDN.
   *
   * Default on. It is what an intranet or offline deployment needs, and it
   * removes a dependency that degrades silently: on 2026-11-08, of 1570
   * providers only 447 resolved to an upstream logo and every other card fell
   * through to a third-party favicon service at render time.
   *
   * A failed download is not fatal — that provider keeps its remote URL.
   * `PROVIDER_ICONS_REMOTE=1` skips downloading entirely (fast local iteration).
   */
  localize?: boolean;
  /** Directory the localised icons are written to, relative to the vite root. */
  localDir?: string;
  /** Parallelism for the downloads. */
  concurrency?: number;
}

/** Bundles OOMOL's provider icon mapping and caches it for the lifetime of the Vite process. */
export function providerIconsPlugin(options: ProviderIconsPluginOptions = {}): Plugin {
  let cachedModule: Promise<string> | undefined;
  let root = process.cwd();
  let publicBase = "/";

  return {
    name: "oomol-provider-icons",
    configResolved(config) {
      root = config.root;
      publicBase = config.base ?? "/";
    },
    resolveId(id): string | undefined {
      return id === publicModuleId ? resolvedModuleId : undefined;
    },
    load(id): Promise<string> | undefined {
      if (id !== resolvedModuleId) {
        return undefined;
      }
      cachedModule ??= options.iconUrls
        ? Promise.resolve(serializeProviderIcons(options.iconUrls))
        : loadProviderIconsModule({
            localize: options.localize ?? process.env.PROVIDER_ICONS_REMOTE !== "1",
            root,
            publicBase,
            localDir: options.localDir ?? "public/provider-icons",
            concurrency: options.concurrency ?? 8,
            warn: (message) => this.warn(message),
          }).catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            this.warn(`Provider icon catalog unavailable: ${reason}. Using default provider icons.`);
            return serializeProviderIcons({});
          });
      return cachedModule;
    },
  };
}

async function loadProviderIconsModule(options: {
  localize: boolean;
  root: string;
  publicBase: string;
  localDir: string;
  concurrency: number;
  warn(message: string): void;
}): Promise<string> {
  const response = await fetch(catalogUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Could not load OOMOL provider icons: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as CatalogPayload;
  if (!Array.isArray(payload.data)) {
    throw new Error("Could not load OOMOL provider icons: catalog.data is not an array");
  }

  const iconUrls: Record<string, string> = {};
  for (const item of payload.data as CatalogItem[]) {
    if (typeof item.service === "string" && typeof item.iconUrl === "string" && item.iconUrl.trim()) {
      iconUrls[item.service] = item.iconUrl;
    }
  }

  if (!options.localize) {
    return serializeProviderIcons(iconUrls);
  }

  return serializeProviderIcons(await localizeIcons(iconUrls, options));
}

/**
 * Download each icon into the public dir and rewrite the map to the copied path.
 *
 * The rewrite is per service: one slow or missing icon must not cost the whole
 * wall its artwork, so a failure keeps the remote URL and is reported once, in
 * aggregate, rather than one warning per provider.
 */
async function localizeIcons(
  iconUrls: Readonly<Record<string, string>>,
  options: {
    root: string;
    publicBase: string;
    localDir: string;
    concurrency: number;
    warn(message: string): void;
  },
): Promise<Record<string, string>> {
  const dir = join(options.root, options.localDir);
  // Rebuild from scratch: a provider that dropped its logo upstream must not
  // keep serving a stale file from an earlier build.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const entries = Object.entries(iconUrls);
  const rewritten: Record<string, string> = {};
  let failed = 0;
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= entries.length) return;
      const [service, url] = entries[index];
      const name = fileNameFor(service, url);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(String(response.status));
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0) throw new Error("empty body");
        writeFileSync(join(dir, name), bytes);
        rewritten[service] = iconHref(options.publicBase, options.localDir, dir, name, options.root);
      } catch {
        failed += 1;
        rewritten[service] = url;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  if (failed > 0) {
    options.warn(
      `Provider icons: kept the remote URL for ${failed}/${entries.length} icon(s) that could not be downloaded.`,
    );
  }
  return rewritten;
}

/** The URL a copied icon is served from: drop the `public/` prefix, keep the base. */
function iconHref(publicBase: string, localDir: string, dir: string, name: string, root: string): string {
  const served = relative(join(root, "public"), join(dir, name)).split("\\").join("/");
  const base = publicBase.endsWith("/") ? publicBase : `${publicBase}/`;
  return `${base}${served}`;
}

/** A filename that is filesystem-safe and keeps the upstream extension. */
function fileNameFor(service: string, url: string): string {
  const ext = extname(new URL(url).pathname) || ".png";
  const safe = service.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe}${ext}`;
}

function serializeProviderIcons(iconUrls: Readonly<Record<string, string>>): string {
  return `export default ${JSON.stringify(iconUrls)};`;
}
