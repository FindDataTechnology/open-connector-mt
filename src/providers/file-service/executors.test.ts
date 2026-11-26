import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { credentialValidators, executors } from "./executors.ts";

const credential: Extract<ResolvedCredential, { authType: "custom_credential" }> = {
  authType: "custom_credential",
  values: { baseUrl: "https://files.example.com" },
  profile: { accountId: "file-service:files.example.com", displayName: "File Service", grantedScopes: [] },
  metadata: {},
};

const context: ExecutionContext = {
  getCredential: async () => credential,
};

afterEach(() => {
  setDefaultGuardedFetchDnsLookup(null);
  vi.unstubAllGlobals();
});

describe("file-service egress and credential guards", () => {
  it("rejects an allowlisted service host that resolves to cloud metadata before any fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    setDefaultGuardedFetchDnsLookup(async () => [{ address: "169.254.169.254", family: 4 }]);

    const result = await executors["file-service.create_upload_url"]!(
      { owner: "wire:cust_x", size: 10, sha256: "a".repeat(64) },
      context,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("must not resolve to private or reserved IP addresses") },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a cloud-metadata baseUrl during credential validation", async () => {
    const fetch = vi.fn();

    const result = await credentialValidators.customCredential!(
      { values: { baseUrl: "http://169.254.169.254" } },
      { fetcher: fetch },
    ).catch((error: Error) => error);

    expect(result).toBeInstanceOf(Error);
    expect(String((result as Error).message)).toContain("must not target private or reserved IP addresses");
    expect(fetch).not.toHaveBeenCalled();
  });
});
