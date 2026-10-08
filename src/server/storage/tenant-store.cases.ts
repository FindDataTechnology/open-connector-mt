import type { ResolvedCredential } from "../../core/types.ts";
import type { RuntimeDatabase } from "./runtime-database.ts";

import { expect, it } from "vitest";
import { RuntimeTokenService } from "./runtime-token-service.ts";

function emptyPolicy() {
  return { allowedActions: [], blockedActions: [], allowedProxies: [], allowedConnections: [] };
}

function credential(accountId: string): ResolvedCredential {
  return {
    authType: "api_key",
    apiKey: `secret-${accountId}`,
    values: { apiKey: `secret-${accountId}` },
    profile: { accountId, displayName: accountId, grantedScopes: [] },
    metadata: { providerAccountVerified: true },
  };
}

/** Shared tenant/identity/consent store cases, run against every SQL dialect. */
export function tenantStoreTests(getDatabase: () => RuntimeDatabase): void {
  it("registers an identity on first sight and reuses its tenant afterwards", async () => {
    const database = getDatabase();
    const first = await database.tenantStore.upsertIdentity({
      issuer: "https://idp.example",
      subject: "sub-1",
      email: "user@example.com",
      displayName: "User One",
    });
    expect(first.created).toBe(true);
    expect(first.identity.tenantId).toBeTruthy();

    const second = await database.tenantStore.upsertIdentity({
      issuer: "https://idp.example",
      subject: "sub-1",
      email: "newer@example.com",
    });
    expect(second.created).toBe(false);
    expect(second.identity.tenantId).toBe(first.identity.tenantId);
    expect(second.identity.email).toBe("newer@example.com");

    // A different issuer with the same subject is a distinct identity/tenant.
    const other = await database.tenantStore.upsertIdentity({ issuer: "https://other.example", subject: "sub-1" });
    expect(other.created).toBe(true);
    expect(other.identity.tenantId).not.toBe(first.identity.tenantId);
  });

  it("disables an identity and reports it", async () => {
    const database = getDatabase();
    const { identity } = await database.tenantStore.upsertIdentity({ issuer: "https://idp.example", subject: "dis" });
    expect(identity.disabledAt).toBeUndefined();
    await database.tenantStore.setIdentityDisabled(identity.id, true);
    const after = await database.tenantStore.getIdentityById(identity.id);
    expect(after?.disabledAt).toBeTruthy();
    await database.tenantStore.setIdentityDisabled(identity.id, false);
    expect((await database.tenantStore.getIdentityById(identity.id))?.disabledAt).toBeUndefined();
  });

  it("scopes connections per tenant and keeps same-name connections independent", async () => {
    const database = getDatabase();
    const tenantA = (await database.tenantStore.upsertIdentity({ issuer: "https://idp.example", subject: "a" })).identity.tenantId;
    const tenantB = (await database.tenantStore.upsertIdentity({ issuer: "https://idp.example", subject: "b" })).identity.tenantId;

    const a = await database.connectionStore.set("github", "default", credential("a"), tenantA);
    await database.connectionStore.set("github", "default", credential("b"), tenantB);

    const readA = await database.connectionStore.get("github", "default", tenantA);
    const readB = await database.connectionStore.get("github", "default", tenantB);
    expect(readA?.credential).toMatchObject({ apiKey: "secret-a" });
    expect(readB?.credential).toMatchObject({ apiKey: "secret-b" });
    expect(readA?.tenantId).toBe(tenantA);

    // Cross-tenant reads see nothing; tenant lists are disjoint.
    expect(await database.connectionStore.get("github", "default", "no-such-tenant")).toBeUndefined();
    expect((await database.connectionStore.list(tenantA)).map((c) => c.id)).toEqual([a.id]);
  });

  it("deleting an identity cascades to its tenant's resources", async () => {
    const database = getDatabase();
    const { identity } = await database.tenantStore.upsertIdentity({ issuer: "https://idp.example", subject: "gone" });
    const tenantId = identity.tenantId;
    await database.connectionStore.set("github", "work", credential("gone"), tenantId);
    const tokens = new RuntimeTokenService(database.runtimeTokenStore);
    const { record: pat } = await tokens.createToken("user-pat", emptyPolicy(), { kind: "user_pat", tenantId });
    await database.tenantStore.grantConsent(tenantId, pat.id);
    expect(await database.tenantStore.hasConsent(tenantId, pat.id)).toBe(true);

    await database.tenantStore.deleteIdentityCascade(identity.id);

    expect(await database.tenantStore.getIdentity(identity.issuer, identity.subject)).toBeUndefined();
    expect(await database.tenantStore.getTenant(tenantId)).toBeUndefined();
    expect(await database.connectionStore.get("github", "work", tenantId)).toBeUndefined();
    // The tenant's PAT rows die with the tenant; consents referencing them are gone too.
    expect(await database.runtimeTokenStore.list().then((rows) => rows.some((r) => r.id === pat.id))).toBe(false);
    expect(await database.tenantStore.hasConsent(tenantId, pat.id)).toBe(false);
  });

  it("leaves unknown identity deletions as a no-op", async () => {
    const database = getDatabase();
    await expect(database.tenantStore.deleteIdentityCascade("missing-id")).resolves.toBeUndefined();
  });

  it("drops consents when their service token is revoked", async () => {
    const database = getDatabase();
    const tenantId = (await database.tenantStore.upsertIdentity({ issuer: "https://idp.example", subject: "c" }))
      .identity.tenantId;
    const tokens = new RuntimeTokenService(database.runtimeTokenStore);
    const { record: servicePat } = await tokens.createToken("service", emptyPolicy(), { kind: "service_pat" });
    await database.tenantStore.grantConsent(tenantId, servicePat.id);
    await database.tenantStore.grantConsent(tenantId, servicePat.id); // idempotent
    expect(await database.tenantStore.hasConsent(tenantId, servicePat.id)).toBe(true);

    await database.tenantStore.revokeConsentsForToken(servicePat.id);
    expect(await database.tenantStore.hasConsent(tenantId, servicePat.id)).toBe(false);
  });
}
