import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerIconsPlugin } from "../provider-icons-plugin";

afterEach(() => vi.unstubAllGlobals());

const DIRS: string[] = [];

/** A throwaway vite root whose `public/` the plugin may write into. */
function tempRoot(): { root: string; localDir: string } {
  const root = mkdtempSync(join(tmpdir(), "provider-icons-"));
  mkdirSync(join(root, "public"), { recursive: true });
  DIRS.push(root);
  return { root, localDir: "public/provider-icons" };
}

function loadSource(plugin: ReturnType<typeof providerIconsPlugin>, warn: (m: string) => void) {
  if (typeof plugin.load !== "function") throw new Error("Expected the icon load hook");
  return Reflect.apply(plugin.load, { warn }, ["\0virtual:oomol-provider-icons"]) as Promise<string>;
}

/** The plugin resolves its write target from the vite root captured in configResolved. */
function withRoot(plugin: ReturnType<typeof providerIconsPlugin>, root: string) {
  const resolved = plugin.configResolved as unknown as (config: { root: string; base: string }) => void;
  resolved({ root, base: "/" });
  return plugin;
}

describe("provider icon catalog", () => {
  it("keeps the build usable and caches the fallback when the catalog is unavailable", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404, statusText: "Not Found" }));
    vi.stubGlobal("fetch", fetcher);
    const { root, localDir } = tempRoot();
    const plugin = withRoot(providerIconsPlugin({ localDir }), root);
    const warn = vi.fn();
    const first = await loadSource(plugin, warn);
    const second = await loadSource(plugin, warn);
    expect(first).toBe("export default {};");
    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("404 Not Found"));
  });

  it("downloads each logo and points the map at the copied file", async () => {
    const { root, localDir } = tempRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/apps")) {
          return Response.json({ data: [{ service: "github", iconUrl: "https://static.example.com/github.svg" }] });
        }
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
      }),
    );
    const plugin = withRoot(providerIconsPlugin({ localDir }), root);
    const warn = vi.fn();
    const source = await loadSource(plugin, warn);

    // The map points at the local path, and the bytes really landed there.
    expect(source).toContain('"github":"/provider-icons/github.svg"');
    const copied = join(root, localDir, "github.svg");
    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the remote URL for a single failed download instead of failing the build", async () => {
    const { root, localDir } = tempRoot();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/apps")) {
          return Response.json({
            data: [
              { service: "good", iconUrl: "https://static.example.com/good.svg" },
              { service: "broken", iconUrl: "https://static.example.com/broken.svg" },
            ],
          });
        }
        return url.includes("broken")
          ? new Response(null, { status: 500 })
          : new Response(new Uint8Array([9]), { status: 200 });
      }),
    );
    const plugin = withRoot(providerIconsPlugin({ localDir }), root);
    const warn = vi.fn();
    const source = await loadSource(plugin, warn);

    expect(source).toContain('"good":"/provider-icons/good.svg"');
    expect(source).toContain('"broken":"https://static.example.com/broken.svg"');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1/2"));
  });

  it("PROVIDER_ICONS_REMOTE=1 keeps the upstream URLs and downloads nothing", async () => {
    const { root, localDir } = tempRoot();
    const fetcher = vi.fn(async () =>
      Response.json({ data: [{ service: "github", iconUrl: "https://static.example.com/github.svg" }] }),
    );
    vi.stubGlobal("fetch", fetcher);
    const plugin = withRoot(providerIconsPlugin({ localDir, localize: false }), root);
    const warn = vi.fn();
    const source = await loadSource(plugin, warn);

    expect(source).toContain('"github":"https://static.example.com/github.svg"');
    expect(fetcher).toHaveBeenCalledTimes(1); // the catalog only — no per-icon download
    expect(existsSync(join(root, localDir, "github.svg"))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  for (const dir of DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});
