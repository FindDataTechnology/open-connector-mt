import type { TokenPolicy } from "../../core/action-policy.ts";
import type { IRuntimeTokenStore, RuntimeTokenRecord } from "./runtime-token-service.ts";

import { describe, expect, it, vi } from "vitest";
import { hashRuntimeToken, RuntimeTokenService } from "./runtime-token-service.ts";

describe("RuntimeTokenService", () => {
  it("rejects non-runtime-token values without reading the store", async () => {
    const store: IRuntimeTokenStore = {
      add: vi.fn(),
      list: vi.fn(async () => []),
      findByHash: vi.fn(),
      updatePolicy: vi.fn(),
      revoke: vi.fn(async () => false),
      markUsed: vi.fn(),
    };
    const service = new RuntimeTokenService(store);

    await expect(service.verifyToken("jwt.access.token")).resolves.toBe(false);
    expect(store.findByHash).not.toHaveBeenCalled();
    expect(store.markUsed).not.toHaveBeenCalled();
  });

  it("resolves stored tokens by hash into a scoped grant", async () => {
    const token = "oct_secret";
    const record = {
      id: "token-1",
      name: "Issue bot",
      tokenHash: hashRuntimeToken(token),
      allowedActions: ["github.*"],
      blockedActions: ["github.delete_repository"],
      allowedProxies: ["github"],
      allowedConnections: ["example:work"],
      createdAt: "2026-07-20T00:00:00.000Z",
    };
    const store: IRuntimeTokenStore = {
      add: vi.fn(),
      list: vi.fn(async () => [record]),
      findByHash: vi.fn(async () => record),
      updatePolicy: vi.fn(),
      revoke: vi.fn(async () => false),
      markUsed: vi.fn(),
    };

    await expect(new RuntimeTokenService(store).resolveToken(token)).resolves.toEqual({
      allowedTriggers: [],
      tokenId: "token-1",
      allowedActions: ["github.*"],
      blockedActions: ["github.delete_repository"],
      allowedProxies: ["github"],
      allowedConnections: ["example:work"],
      allowedOperations: [],
    });
    expect(store.findByHash).toHaveBeenCalledWith(record.tokenHash);
    expect(store.list).not.toHaveBeenCalled();
    expect(store.markUsed).toHaveBeenCalledWith("token-1", expect.any(String));
  });

  it("keeps a matched token valid when the last-use write fails", async () => {
    const token = "oct_secret";
    const record = {
      id: "token-1",
      name: "Issue bot",
      tokenHash: hashRuntimeToken(token),
      allowedActions: [],
      blockedActions: [],
      allowedProxies: [],
      allowedConnections: [],
      createdAt: "2026-07-20T00:00:00.000Z",
    };
    const store: IRuntimeTokenStore = {
      add: vi.fn(),
      list: vi.fn(async () => [record]),
      findByHash: vi.fn(async () => record),
      updatePolicy: vi.fn(),
      revoke: vi.fn(async () => false),
      markUsed: vi.fn(async () => {
        throw new Error("D1_ERROR: network connection lost");
      }),
    };
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

    await expect(new RuntimeTokenService(store, logger).resolveToken(token)).resolves.toEqual({
      allowedTriggers: [],
      tokenId: "token-1",
      allowedActions: [],
      blockedActions: [],
      allowedProxies: [],
      allowedConnections: [],
      allowedOperations: [],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { tokenId: "token-1", err: expect.any(Error) },
      "runtime token last use update failed",
    );
  });

  it("preserves allowedConnections across create, list, resolve, and update", async () => {
    const service = new RuntimeTokenService(new MemoryRuntimeTokenStore());
    const created = await service.createToken("Issue bot", {
      allowedActions: ["github.*"],
      blockedActions: ["github.delete_repository"],
      allowedProxies: ["github"],
      allowedConnections: ["example:work", "example:personal"],
    });

    expect(created.record.allowedConnections).toEqual(["example:work", "example:personal"]);
    await expect(service.listTokens()).resolves.toMatchObject([
      { id: created.record.id, allowedConnections: ["example:work", "example:personal"] },
    ]);
    await expect(service.resolveToken(created.token)).resolves.toMatchObject({
      tokenId: created.record.id,
      allowedConnections: ["example:work", "example:personal"],
    });
    await expect(
      service.updateTokenPolicy(created.record.id, {
        allowedActions: ["github.get_current_user"],
        blockedActions: [],
        allowedProxies: ["slack"],
        allowedConnections: ["example:work"],
      }),
    ).resolves.toMatchObject({ allowedConnections: ["example:work"] });
    await expect(service.resolveToken(created.token)).resolves.toMatchObject({
      allowedConnections: ["example:work"],
    });
  });

  it("defaults omitted allowedConnections to an unrestricted empty list", async () => {
    const created = await new RuntimeTokenService(new MemoryRuntimeTokenStore()).createToken("Issue bot");
    expect(created.record.allowedConnections).toEqual([]);
    expect(created.record).toMatchObject({
      allowedActions: [],
      blockedActions: [],
      allowedProxies: [],
      allowedConnections: [],
    });
  });

  it("carries purpose and parentTokenId through create, list, and resolve", async () => {
    const service = new RuntimeTokenService(new MemoryRuntimeTokenStore());
    const created = await service.createToken(
      "binding:erp-supply/kingdee-cloud",
      {
        allowedActions: ["kingdee.*"],
        blockedActions: [],
        allowedProxies: [],
        allowedConnections: [],
      },
      {
        kind: "user_pat",
        tenantId: "tenant-1",
        purpose: "binding:erp-supply/kingdee-cloud",
        parentTokenId: "parent-1",
      },
    );

    expect(created.record).toMatchObject({
      purpose: "binding:erp-supply/kingdee-cloud",
      parentTokenId: "parent-1",
    });
    await expect(service.listTokens()).resolves.toMatchObject([
      { id: created.record.id, purpose: "binding:erp-supply/kingdee-cloud", parentTokenId: "parent-1" },
    ]);
  });

  it("revokes tokens attenuated from the revoked parent", async () => {
    const store = new MemoryRuntimeTokenStore();
    const service = new RuntimeTokenService(store);
    const parent = await service.createToken("chat:explore", undefined, {
      kind: "user_pat",
      tenantId: "tenant-1",
      purpose: "built-in free exploration",
    });
    const child = await service.createToken("binding:erp/kingdee", undefined, {
      kind: "user_pat",
      tenantId: "tenant-1",
      purpose: "binding:erp/kingdee",
      parentTokenId: parent.record.id,
    });
    const grandchild = await service.createToken("binding:erp/kingdee-read", undefined, {
      kind: "user_pat",
      tenantId: "tenant-1",
      purpose: "binding:erp/kingdee-read",
      parentTokenId: child.record.id,
    });
    const sibling = await service.createToken("binding:other", undefined, {
      kind: "user_pat",
      tenantId: "tenant-1",
      purpose: "binding:other",
    });

    await expect(service.revokeToken(parent.record.id)).resolves.toBe(true);

    await expect(service.resolveToken(parent.token)).resolves.toBeUndefined();
    await expect(service.resolveToken(child.token)).resolves.toBeUndefined();
    await expect(service.resolveToken(grandchild.token)).resolves.toBeUndefined();
    // A token derived from someone else survives.
    await expect(service.resolveToken(sibling.token)).resolves.toBeDefined();
  });

  it("reports whether the revoked token itself existed", async () => {
    await expect(new RuntimeTokenService(new MemoryRuntimeTokenStore()).revokeToken("missing")).resolves.toBe(false);
  });
});

class MemoryRuntimeTokenStore implements IRuntimeTokenStore {
  private readonly tokens = new Map<string, RuntimeTokenRecord>();

  async add(record: RuntimeTokenRecord): Promise<void> {
    this.tokens.set(record.id, record);
  }

  async list(): Promise<RuntimeTokenRecord[]> {
    return [...this.tokens.values()];
  }

  async findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined> {
    return [...this.tokens.values()].find((token) => token.tokenHash === tokenHash);
  }

  async updatePolicy(id: string, policy: TokenPolicy): Promise<RuntimeTokenRecord | undefined> {
    const token = this.tokens.get(id);
    if (!token) {
      return undefined;
    }
    const updated = {
      ...token,
      ...policy,
      allowedConnections: policy.allowedConnections ?? [],
    };
    this.tokens.set(id, updated);
    return updated;
  }

  async revoke(id: string): Promise<boolean> {
    return this.tokens.delete(id);
  }

  async markUsed(id: string, usedAt: string): Promise<void> {
    const token = this.tokens.get(id);
    if (token) {
      this.tokens.set(id, { ...token, lastUsedAt: usedAt });
    }
  }
}
