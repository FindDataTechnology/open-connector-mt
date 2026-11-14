import { describe, expect, it } from "vitest";
import {
  CATALOG_READ_MODE_ENV,
  CATALOG_READ_TOKEN_ENV,
  describeCatalogReadConfig,
  readCatalogReadConfig,
} from "./catalog-read-config.ts";

/**
 * The switch decides whether a read-only catalog surface exists at all, so the
 * failure modes are the test: a typo must not become "public", and `service`
 * without a token must not boot into "reject everything forever".
 */
describe("catalog read surface configuration", () => {
  it("is off when unset or explicitly off", () => {
    expect(readCatalogReadConfig({})).toEqual({ mode: "off" });
    expect(readCatalogReadConfig({ [CATALOG_READ_MODE_ENV]: "" })).toEqual({ mode: "off" });
    expect(readCatalogReadConfig({ [CATALOG_READ_MODE_ENV]: "off" })).toEqual({ mode: "off" });
  });

  it("accepts public without a token", () => {
    expect(readCatalogReadConfig({ [CATALOG_READ_MODE_ENV]: "public" })).toEqual({ mode: "public" });
  });

  it("accepts service with a token", () => {
    expect(
      readCatalogReadConfig({ [CATALOG_READ_MODE_ENV]: "service", [CATALOG_READ_TOKEN_ENV]: "tok_catalog" }),
    ).toEqual({ mode: "service", token: "tok_catalog" });
  });

  it("refuses an unrecognized mode instead of degrading to off or public", () => {
    expect(() => readCatalogReadConfig({ [CATALOG_READ_MODE_ENV]: "opened" })).toThrow(
      /OOMOL_CONNECT_CATALOG_READ must be one of: off, public, service/,
    );
  });

  it("refuses service mode without a token at boot", () => {
    expect(() => readCatalogReadConfig({ [CATALOG_READ_MODE_ENV]: "service" })).toThrow(
      /requires OOMOL_CONNECT_CATALOG_READ_TOKEN/,
    );
    expect(() =>
      readCatalogReadConfig({ [CATALOG_READ_MODE_ENV]: "service", [CATALOG_READ_TOKEN_ENV]: "   " }),
    ).toThrow(/requires OOMOL_CONNECT_CATALOG_READ_TOKEN/);
  });

  it("names the mode in one line so an operator can confirm what is on", () => {
    expect(describeCatalogReadConfig({ mode: "off" })).toBe("catalog read surface: off");
    expect(describeCatalogReadConfig({ mode: "service", token: "x" })).toBe("catalog read surface: service");
    // The token itself never reaches the log line.
    expect(describeCatalogReadConfig({ mode: "service", token: "secret-token" })).not.toContain("secret-token");
  });
});
