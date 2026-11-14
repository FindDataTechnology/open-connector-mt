// Boot description of the service-identity key space (D10 of paas
// add-served-agent-connector-access). The line exists because the failure it
// describes is indistinguishable from its own explanation: a caller signed in
// under another issuer reads as `actor_unregistered`, which is exactly what
// "nobody ever signed in" reads as. These assertions pin the two properties
// that make the line usable — it says WHICH issuer, and it says WHAT happens
// on a mismatch — plus the one that keeps it out of the way.
import { describe, expect, it } from "vitest";
import { describeServiceIdentity, readTenancyConfig } from "./constants.ts";

const base = {
  TENANCY: "oidc",
  OOMOL_CONNECT_JWKS_URI: "https://idp/jwks",
  OOMOL_CONNECT_JWT_ISSUER: "https://idp/oidc",
  OOMOL_CONNECT_JWT_AUDIENCE: "client",
};

describe("describeServiceIdentity", () => {
  it("says nothing when tenancy is off — SERVICE_OBO is inert there", () => {
    expect(describeServiceIdentity(readTenancyConfig({}))).toBeUndefined();
    expect(describeServiceIdentity(readTenancyConfig({ SERVICE_OBO: "allow-all" }))).toBeUndefined();
  });

  it("names the issuer actors resolve against and the consequence of a mismatch", () => {
    const line = describeServiceIdentity(readTenancyConfig({ ...base, SERVICE_OBO: "allow-all" }));
    expect(line).toBeTypeOf("string");
    expect(line).toContain("https://idp/oidc");
    expect(line).toContain("actor_unregistered");
    expect(line).toContain("allow-all");
  });

  it("reflects the OBO mode it actually read, so a flip cannot leave a stale line", () => {
    const allowAll = describeServiceIdentity(readTenancyConfig({ ...base, SERVICE_OBO: "allow-all" }));
    const consent = describeServiceIdentity(readTenancyConfig({ ...base, SERVICE_OBO: "consent" }));
    const off = describeServiceIdentity(readTenancyConfig({ ...base, SERVICE_OBO: "off" }));
    expect(allowAll).not.toBe(consent);
    expect(off).toContain("off");
    expect(off).not.toContain("allow-all");
  });

  it("marks a missing issuer instead of printing a blank", () => {
    const { OOMOL_CONNECT_JWT_ISSUER: _omitted, ...withoutIssuer } = base;
    const line = describeServiceIdentity(readTenancyConfig(withoutIssuer));
    expect(line).toContain("(unset)");
  });
});
