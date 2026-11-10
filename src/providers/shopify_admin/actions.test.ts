import { describe, expect, it } from "vitest";

import { shopifyAdminActions } from "./actions.ts";
import { shopifyAdminActionHandlers } from "./runtime.ts";

/**
 * 声明 ↔ 实现 ↔ 交叉引用 的一致性守卫。
 *
 * 为什么这个 provider 需要它：能力矩阵里每一条 Shopify 的「能读到」凭据
 * (`provider_action`) 都指向这里的动作名，而 `shopify_admin` 此前是唯一
 * 没有测试文件的 provider——`esa` / `moneyforward_mcp` 都有同类断言。
 *
 * 类型系统只保证「实现键 ⊆ 联合类型」（`ProviderActionHandlers` 是对联合类型的
 * `Record`），但**不保证** `shopifyAdminActions` 这个手写数组与联合类型/实现一致：
 * - 声明了却没实现 → 目录里点得到、一跑就 500；
 * - 实现了却没声明 → 目录里看不见，等于白写。
 * 两种都只在运行时暴露，所以在这里钉住。
 */
describe("shopify_admin action surface", () => {
  const declared = shopifyAdminActions.map((action) => action.name);
  const handled = Object.keys(shopifyAdminActionHandlers);

  it("declares and implements exactly the same actions", () => {
    expect(declared.slice().sort()).toEqual(handled.slice().sort());
  });

  it("has no duplicate declarations", () => {
    expect(declared.length).toBe(new Set(declared).size);
  });

  it("keeps action ids namespaced with the service", () => {
    const bad = shopifyAdminActions
      .map((action) => action.id)
      .filter((id) => !id.startsWith("shopify_admin."));
    expect(bad).toEqual([]);
  });

  it("gives every action a description and a valid operation type", () => {
    const problems = shopifyAdminActions
      .filter(
        (action) =>
          action.description.trim().length === 0 ||
          !["read", "write", "destructive"].includes(action.operationType),
      )
      .map((action) => `${action.name}:${action.operationType}`);
    expect(problems).toEqual([]);
  });

  /**
   * 交叉引用必须是活链接。
   *
   * `followUpActions` 与 `asyncLifecycle` 是给目录/UI 的指路牌；指向一个不存在的
   * 动作时不会有任何编译错误，只会让「下一步」按钮点了没用。这类断链在本仓有过
   * 先例（岗位包 target 指向不存在的 presetId，铸造必空岗），所以在数据层查。
   */
  it("has no dangling follow-up or async-lifecycle references", () => {
    const known = new Set(shopifyAdminActions.map((action) => action.id));
    const dangling: string[] = [];
    for (const action of shopifyAdminActions) {
      for (const id of action.followUpActions ?? []) {
        if (!known.has(id)) dangling.push(`${action.name}.followUpActions -> ${id}`);
      }
      const lifecycle = action.asyncLifecycle;
      if (lifecycle) {
        for (const id of [lifecycle.startActionId, lifecycle.statusActionId]) {
          if (!known.has(id)) dangling.push(`${action.name}.asyncLifecycle -> ${id}`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  /**
   * 电商对账模板引用的五个读取动作必须真实存在。
   *
   * `fd-erp-vertical-templates` 的 `capability-matrix.json` 用符号锚
   * (`actions.ts#list_orders` 等) 指向本文件；那边只能验「符号出现在文件里」，
   * 验不了「这个动作真的注册进了目录并可执行」。两侧各守一半。
   */
  it("keeps the actions cited by the e-commerce capability matrix", () => {
    const cited = [
      "list_orders",
      "get_order",
      "list_inventory_items",
      "get_inventory_item",
      "list_payouts",
    ];
    expect(cited.filter((name) => !declared.includes(name))).toEqual([]);
    expect(cited.filter((name) => !handled.includes(name))).toEqual([]);
  });
});

/**
 * 执行器真的跑一遍——不是「目录里有个 .test.ts」就算数。
 *
 * `fd-erp-vertical-templates` 的三态台账把 `executor_tests` 定义为
 * 「该 provider 的执行器有测试」（扫描 `src/providers/<id>/*.test.ts`）。
 * 如果这个文件只验声明面，那条状态就会因为「有个测试文件」而变绿，而执行器
 * 一行都没被执行过——这正是「门因为名义上的证据变绿」。所以这里用假 fetcher
 * 把 list_payouts 真跑一遍，连请求形状一起断言。
 */
describe("shopify_admin list_payouts executor", () => {
  interface Captured {
    url: string;
    init: RequestInit | undefined;
  }

  function contextWith(response: unknown, status = 200) {
    const captured: Captured[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init });
      return new Response(JSON.stringify(response), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return {
      captured,
      context: {
        apiKey: "shpat_test_token",
        shopDomain: "demo-store.myshopify.com",
        fetcher,
      },
    };
  }

  it("posts a GraphQL query to the versioned endpoint with the access token", async () => {
    const { captured, context } = contextWith({
      data: {
        shopifyPaymentsAccount: {
          payouts: {
            edges: [
              {
                cursor: "cur-1",
                node: {
                  id: "gid://shopify/ShopifyPaymentsPayout/1",
                  issuedAt: "2026-11-01T00:00:00Z",
                  status: "PAID",
                  amount: { amount: "1234.56", currencyCode: "USD" },
                  summary: { adjustmentsFeeAmount: "1.00", chargesFeeAmount: "20.00" },
                },
              },
            ],
            pageInfo: {
              hasNextPage: false,
              hasPreviousPage: false,
              startCursor: "cur-1",
              endCursor: "cur-1",
            },
          },
        },
      },
    });

    const result = (await shopifyAdminActionHandlers.list_payouts({ first: 10 }, context)) as {
      payouts: Record<string, unknown>[];
      payoutsAccountAvailable: boolean;
    };

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://demo-store.myshopify.com/admin/api/2026-04/graphql.json");
    expect(captured[0].init?.method).toBe("POST");
    const headers = captured[0].init?.headers as Record<string, string>;
    expect(headers["x-shopify-access-token"]).toBe("shpat_test_token");
    expect(String(captured[0].init?.body)).toContain("shopifyPaymentsAccount");

    expect(result.payoutsAccountAvailable).toBe(true);
    expect(result.payouts[0]).toMatchObject({
      id: "gid://shopify/ShopifyPaymentsPayout/1",
      issuedAt: "2026-11-01T00:00:00Z",
      status: "PAID",
      amount: "1234.56",
      currencyCode: "USD",
      cursor: "cur-1",
    });
  });

  it("reports an absent Shopify Payments account instead of an empty payout list", async () => {
    const { context } = contextWith({ data: { shopifyPaymentsAccount: null } });
    const result = (await shopifyAdminActionHandlers.list_payouts({}, context)) as {
      payouts: unknown[];
      payoutsAccountAvailable: boolean;
    };
    // 关键语义：没有 Shopify Payments ≠ 没有打款。读成后者会静默漏账。
    expect(result.payoutsAccountAvailable).toBe(false);
    expect(result.payouts).toEqual([]);
  });

  it("surfaces an upstream auth failure as a provider request error", async () => {
    const { context } = contextWith(
      { errors: [{ message: "Invalid API key or access token" }] },
      401,
    );
    await expect(shopifyAdminActionHandlers.list_payouts({}, context)).rejects.toMatchObject({
      status: 401,
    });
  });
});
