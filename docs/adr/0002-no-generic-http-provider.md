# 不为 POS / 国内电商平台开「通用 HTTP provider」，走每客户骨架

**状态**：已决（2026-11-08）。本文档记录决策与理由，并给出两份骨架契约的落点。

## 背景

ERP 线三个行业模板的连接器包里，有两条绑定用了**角色形态**（`providerRole: true`）：
`pos`（门店收银，餐饮连锁）与 `cn-commerce`（淘宝/天猫/京东，跨境电商）。角色形态让客户
在自己的连接器里选定实际系统，而**不必要求目录存在同名 provider**。

但 2026-11-08 实测这两个角色的**候选集为空**：目录 1570 家 provider 里没有门店 POS，
也没有淘宝/天猫/京东（`catalog/apps/` 全量核对）。状态面会如实显示"你已连通的系统都覆盖不了
这个包需要的操作——先去连接器连一个"，可客户连不上任何东西。也就是说，**角色绑定把"换一家
客户就要改包"解决了，但没解决"目录里没有这个系统"**。

由此提出过一个看起来最省事的方案：加一个**通用 HTTP provider**——客户填自己的 base URL 与
API key，任意系统都能接。

## 决定

**不做通用 HTTP provider。** 改为沿用 `docs/wms-skeleton-contract.md` 的既有路线：为 POS 与
国内电商平台各立一份**骨架契约**（动作面、凭证形态、trigger 骨架、验收判据），锚点客户的
品牌与接口形态确认后，按同一载体（`src/providers/<service>/` 全新目录）另立 change 实现。

## 理由（按分量排序）

1. **它把连接器变成任意出网代理，而这是本仓刻意没有的东西。** `src/core/guarded-fetch.ts`
   的 SSRF 策略（`assertPublicHttpUrl` + 解析地址白名单）挡的是"目标由代码字面量决定"这一前提——
   1595 个 provider 无一从凭证里取 base URL，无一开 `allowPrivateNetwork`。通用 provider 一旦
   存在，目标就变成**用户输入**：公网 SSRF 仍被挡，但"连接器可以替任何人访问任意公网地址"
   这件事本身是新产品面（滥用为跳板、把客户数据推到任意端点、审计无法按 provider 归因）。
   这不是实现细节，是威胁模型变化。
2. **它把"目录"从策展目录变成协议适配器。** 目录的价值在于每个条目有官方 auth 契约与动作语义，
   所以"接通了"能被解释、被审计、被写进 SLA。通用条目没有语义：`read` 动作读的是什么、返回什么
   形状，只有客户自己知道。绑定声明里的 `allowOperations` 就失去了约束对象。
3. **骨架路线不是空等，它把未来的实现变成机械工作。** WMS 的先例已经证明：骨架写清之后，
   实现就是按契约填 `definition/actions/executors`，且验收判据（一轮闭环）先定，避免"接了但
   没法对账"。POS 与国内电商平台的面比 WMS 更窄（纯只读流水/订单），骨架成本更低。
4. **诚实的现状是可接受的。** 两个角色候选集为空，状态面如实说"先去连一个"；这与"声称支持
   但接不通"相比是更好的失败方式。ERP 线与客户沟通时，正确的说法是"目录里还没有你的收银系统，
   接进来需要一次接入"，而不是"你自己填个 URL 就行"。

## 被否的替代方案

- **通用 HTTP / Webhook provider**（用户填 URL + key）：见理由 1、2。
- **把 `pos` / `cn-commerce` 改成固定 provider 的 `optional` 绑定**：等于回到"必须猜客户的厂商"，
  猜错就是永久 `unwired`；而且目录里没有可猜的对象。
- **用 `n8n` / `browser_use` / `webscraper_io` 兜底**：实测它们的 read 动作是自家 API 管理
  （`n8n.get_execution`、`browser_use.list_sessions`、`webscraper_io.get_scraping_job`），
  不是"代读任意外部系统"。把它们塞进绑定会因类级覆盖通过而**授权一个错的面**——这正是
  2026-11-08 在 `meituan` 与 `shopify` 上刚踩过的坑。

## 后果

- 两条角色绑定在锚点客户确认前保持"候选集为空"，状态面如实报；ERP 侧文档已记录处置口径。
- 骨架契约各自成文（见下），实现另立 change，且**先有客户实例再实现**——避免为想象的接口写 provider。
- 若将来真要做通用通道，它必须作为独立产品决定重新评估（威胁模型、审计、计费口径都要重定义），
  不能以一个 provider 目录条目的形式悄悄上线。

## 骨架契约落点

- 门店 POS：`docs/pos-skeleton-contract.md`
- 国内电商平台：`docs/cn-commerce-skeleton-contract.md`

两份骨架与 `wms-skeleton-contract.md` 同构：载体、动作面骨架（全 `operationType=read`）、
trigger 骨架（有事件面则 webhook 优先、否则 poll）、验收判据、形态分支、前置依赖。
