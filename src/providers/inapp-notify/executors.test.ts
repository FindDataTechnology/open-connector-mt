import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { credentialValidators, executors } from "./executors.ts";

const credential: Extract<ResolvedCredential, { authType: "custom_credential" }> = {
  authType: "custom_credential",
  values: { gatewayUrl: "https://paas.example.com", accountToken: "admin-token" },
  profile: { accountId: "inapp-notify:admin@example.com", displayName: "admin@example.com", grantedScopes: [] },
  metadata: {},
};

const context: ExecutionContext = {
  getCredential: async () => credential,
};

afterEach(() => {
  setDefaultGuardedFetchDnsLookup(null);
  vi.unstubAllGlobals();
});

describe("inapp-notify egress and credential guards", () => {
  it("rejects an allowlisted gateway host that resolves to cloud metadata before any fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    setDefaultGuardedFetchDnsLookup(async () => [{ address: "169.254.169.254", family: 4 }]);

    const result = await executors["inapp-notify.send_broadcast"]!(
      { audience: { kind: "all" }, body: "hello" },
      context,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("must not resolve to private or reserved IP addresses") },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a cloud-metadata gatewayUrl during credential validation", async () => {
    const fetch = vi.fn();

    const result = await credentialValidators.customCredential!(
      { values: { gatewayUrl: "http://169.254.169.254", accountToken: "admin-token" } },
      { fetcher: fetch },
    ).catch((error: Error) => error);

    expect(result).toBeInstanceOf(Error);
    expect(String((result as Error).message)).toContain("must not target private or reserved IP addresses");
    expect(fetch).not.toHaveBeenCalled();
  });
});
