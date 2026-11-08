import type { ProviderDefinition } from "./model";

import { describe, expect, it } from "vitest";
import { providerIconSource } from "./shared-ui";

function provider(options: Partial<ProviderDefinition> & Pick<ProviderDefinition, "service">): ProviderDefinition {
  return {
    displayName: options.displayName ?? options.service,
    categories: [],
    authTypes: [],
    auth: [],
    actions: [],
    ...options,
    service: options.service,
  };
}

describe("providerIconSource", () => {
  it("prefers the provider definition icon", () => {
    expect(
      providerIconSource(provider({ service: "example", iconUrl: " https://example.com/icon.svg " }), {
        example: "https://static.oomol.com/example.svg",
      }),
    ).toEqual({ kind: "url", value: "https://example.com/icon.svg" });
  });

  it("uses the bundled OOMOL catalog icon", () => {
    expect(
      providerIconSource(provider({ service: "example" }), {
        example: "https://static.oomol.com/example.svg",
      }),
    ).toEqual({ kind: "url", value: "https://static.oomol.com/example.svg" });
  });

  it("never reaches a third-party favicon service when no icon is mapped", () => {
    // tenant-console spec, "目录图标随发行物分发": rendering must not need a
    // third-party domain. A provider the build could not localise shows its
    // initials instead of phoning favicon.im.
    expect(
      providerIconSource(provider({ service: "example", homepageUrl: "https://example.com/docs" }), {}),
    ).toBeUndefined();
  });

  it("falls back to initials when no icon or valid homepage is available", () => {
    expect(providerIconSource(provider({ service: "example", homepageUrl: "not a URL" }), {})).toBeUndefined();
  });
});
