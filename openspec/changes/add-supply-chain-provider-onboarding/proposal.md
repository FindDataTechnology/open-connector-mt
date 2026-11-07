# add-supply-chain-provider-onboarding

## Why

需求契约来自 finddata ERP 线（仓配分销垂直模板，客户中性，下称「锚点客户」）：

- `/Users/chengsishi/finddata/fd-erp-vertical-templates/templates/supply-chain/connector-pack/pack.json` —— 金蝶云星空 / 客户 WMS / 支付渠道 / 供应商与承运商门户的连接绑定契约（`connector_bindings`），总纪律：全部外部对接经萬星连接器载体（本仓），多租户、BYOK 凭证不出库。
- `/Users/chengsishi/finddata/fd-erp-vertical-templates/docs/connector-onboarding-supply-chain.md` —— 目录核验（2026-11-07，只读）与立项要点，明确要求 provider 新增在本仓 openspec 根立项。

目录现状（该文档已核验，本 change 抽查一致；catalog 共 1568 providers）：

1. **金蝶云星空**：`catalog/apps/kingdee.json` 在目录（`custom_credential` 6 字段；12 个 formId 通用单据 action；无业务域专用 action、无 trigger）。
2. **支付渠道商户侧**：微信支付 / 支付宝 / 银联均无（`weixin_*` 均非支付：公众号/小店/bot）；国际 PSP 有 Stripe/PayPal 等 10 家，仅 Stripe 有 `on_event` webhook trigger。ERP 结算中心的日终渠道对账与支付回调记录依赖此面，缺口须补。
3. **WMS**：零（最接近的 ShipBob 是 3PL 履约只读面，不是 WMS）。

同时，本仓硬约束「Never modify `src/providers/**`」与「新增 provider」存在张力（新增的合规载体是什么：catalog 覆盖？运行时注册？upstream PR？），须在本 change 内裁定并给出证据。

## What Changes

- **裁定 fork 侧新增 provider 的合规载体**（design D1，本 change 的核心结论）：新增 provider 以 `src/providers/<service>/` 下**全新目录**落地——零既有文件修改、随既有 `npm run generate:catalog` 管线自然流通、可直接投递 upstream PR 归化；fork overlay（自建 catalog 目录 + 运行时注册合并点）被评估并否决。对**既有** provider 的增补（金蝶）只能走 upstream PR，fork 零触碰。
- **新增 `wechatpay` / `alipay` 商户侧 provider**：只读 settlement 面（微信支付 APIv3 交易账单下载 + 交易查询；支付宝对账单下载 + 交易查询）+ 支付结果回调 trigger（挂既有 subscription/receive/reconcile 机制做回调记录）。全 action `operationType=read`，零资金写操作面。
- **WMS 通用接入方案裁定**：SDK provider 骨架契约（库存快照只读 read + 出入库事件 trigger，webhook 优先、否则 poll）与验收判据先行立档；不预设厂商，锚点客户品牌与接口形态确认后按同一载体另立 change 实现。
- **金蝶云星空增补 action 需求评估**：现有 12 通用 action 对凭证推送/往来/发票回写的可用性结论（可用但依赖客户实例预置转换规则）；缺口（开票直连、凭证模板自动生成、银企直连）列 upstream 增补项清单；本仓不改 `src/providers/kingdee/**`。

## Capabilities

### New Capabilities

- `provider-onboarding`：fork 侧供应链 provider 接入载体与边界（支付渠道只读面与回调记录、WMS 骨架裁定、金蝶增补归 upstream）。

### Modified Capabilities

（无）

## Non-goals

- 不提供任何资金写操作面：不发起支付、不做退款/转账/分账（二清红线：平台零资金池；对外付款走金蝶/持牌通道，连接器只读 + 回调记录）。
- 不实现任何具体厂商的 WMS provider（品牌与接口形态未确认，实现另立 change）。
- 不修改 `src/providers/kingdee/**` 或任何既有 provider 文件（上游归属；增补走 upstream PR，见挂账）。
- 不新建 overlay / 运行时注册等第二 provider 载体（D1 已裁定并给出理由与证据）。
- 不触碰任何上游既有文件（upstream-touched = 无）；不新增迁移（回调订阅复用既有 `trigger_subscriptions`，migration 0017）。
- 不做银联商户侧 provider（锚点客户需求未确认，Open Questions 挂账；确认后按本载体同构增补）。
- ERP 侧消费面（结算中心对账计算、日终差异清单、推送留痕）归 ERP 线，本 change 只供数据面。

## Impact

- **代码**：`src/providers/wechatpay/**`、`src/providers/alipay/**` 全新目录（fork-new 文件）；无任何上游既有文件改动。
- **生成物**：`npm run generate:catalog` 再生 `catalog/apps/*.json`、`catalog/apps-index.json`、`registry*.generated.ts`（gitignored 本地运行时数据，非源文件，不入库）。
- **目录**：1568 → 1570 providers。`TENANCY=off` 的租户行为不变（零 tenancy 代码）；目录组成增长是萬星产品面的有意变化，边界解释见 design D2；部署级收口走既有 `actionPolicy` / `allowedTriggers`。
- 无 API wire 形状变化、无 DB 迁移、无 console 变化、无 locale 变化。
- **上游可合并性**：新目录为纯新增路径，双周合并零冲突（唯一例外：上游未来同名 provider 的 add/add，处置见 design D5）；两个 provider 同步投递 upstream PR 归化。
- **验收**：`npm run generate:catalog` 幂等且既有 1568 个 catalog 文件零 diff；vitest 全量（含两 provider 本地 executor 测试）；`npm run fix-check` 绿；`openspec validate add-supply-chain-provider-onboarding --strict` 过。

## 上游文件触碰（upstream-touched）

**无。** 本 change 不触碰任何上游既有文件：

- 新增 provider 全部为 `src/providers/` 下全新目录（fork-new 文件），这是 D1 裁定的载体本身；
- 对既有 provider（kingdee）的增补被明确排除、归 upstream PR（Non-goals）；
- `src/providers/clone-baseline.json` 仅在新 provider 引入克隆类计数时需要变动——本 change 的两个 provider 遵守共享 owner 纪律（`provider-runtime.ts` / `src/core/cast.ts` 等），预期零新增克隆、基线文件不动；若 CI 计数意外变化，按 AGENTS.md 基线流程在本 change 内同改并说明。

生成物文件（`catalog/apps/*.json` 等）位于 `src/providers` 与 `catalog/` 命名空间内但为 gitignored 生成数据，由生成器整目录再生，不构成对上游源文件的修改。
