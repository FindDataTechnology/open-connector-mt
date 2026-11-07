# provider-onboarding Delta — add-supply-chain-provider-onboarding

## ADDED Requirements

### Requirement: 新增 provider 载体为 in-tree additive 新目录

本 fork 新增 provider SHALL 以 `src/providers/<service>/` 全新目录落地：零既有文件修改、零生成器与 runtime 改动，随 `npm run generate:catalog` 进入目录与执行注册表。目录组成变化 SHALL NOT 改变任何租户行为：`TENANCY=off` 与 `TENANCY=oidc` 下 connector 的鉴权、存储、MCP、console 行为保持一致。新增 provider SHALL 同步投递 upstream PR 归化；本 fork SHALL NOT 另建 overlay/运行时注册等第二 provider 载体。

#### Scenario: 生成管线零改动流通

- **WHEN** 新 provider 目录（`definition.ts` / `actions.ts` / `executors.ts`）就位后运行 `npm run generate:catalog`
- **THEN** 该 provider 出现在 `catalog/apps/<service>.json` 与 `apps-index.json`，registry 生成对应 executor 懒加载映射，生成器脚本与 runtime 源文件零改动

#### Scenario: 部署级收口走既有策略

- **WHEN** 某部署不启用新 provider
- **THEN** 经既有 `actionPolicy` / `allowedTriggers` 配置阻断 `<service>.*` 即可收口，零代码改动，目录其余部分照常可用

#### Scenario: 双 tenancy 模式行为一致

- **WHEN** 分别在 `TENANCY=off` 与 `TENANCY=oidc` 下加载目录并执行新 provider 的动作
- **THEN** 鉴权、连接归属、执行语义一致，与既有 provider 无差别

### Requirement: 支付渠道商户侧 provider 只读边界

`wechatpay` 与 `alipay` provider SHALL 只含 `operationType=read` 的 action 与支付结果回调 trigger，SHALL NOT 提供支付发起、退款、转账、分账等任何资金写操作面。凭证形态为商户侧 `custom_credential`（微信支付：商户号/商户 API 证书私钥/证书序列号/APIv3 密钥等；支付宝：appId/应用私钥/支付宝公钥或证书等），凭证 SHALL 加密落库、执行时代入、任何响应不回显原文。

#### Scenario: 目录面全只读

- **WHEN** 检视 `wechatpay` / `alipay` 的 catalog action 列表
- **THEN** 全部 action 的 `operationType` 为 `read`，无 `write` / `destructive`

#### Scenario: 无资金写面可调

- **WHEN** 经 `/v1` 或 MCP 对两 provider 枚举可调用面
- **THEN** 可调面仅限只读 action 与 trigger 操作，不存在支付/退款/转账类 action id

#### Scenario: 凭证不出库

- **WHEN** 创建商户连接并执行一次只读动作
- **THEN** 凭证经 `custom_credential` 加密落库并在执行时代入，API/MCP 响应与错误信息中不出现凭证原文

### Requirement: 支付回调经既有订阅机制落记录

微信支付/支付宝的支付结果回调 SHALL 以 provider trigger 定义接入运行时既有 subscription/receive/reconcile 机制（`src/triggers/`，订阅落 `trigger_subscriptions`）：回调记录归属发起订阅的 runtime token 与 connection，验签由 provider 实现自身完成，nonce 校验与 64 KiB rawBody 上限沿用运行时既有约束。本面 SHALL NOT 新增迁移、SHALL NOT 建平行取数通道。

#### Scenario: 回调落记录

- **WHEN** 一笔真实支付的回调经 trigger `receive` 投递且 provider 验签通过
- **THEN** 回调内容落入既有订阅记录面（归属发起订阅的 runtime token 与 connection），可被同源数据面消费

#### Scenario: 验签失败拒收

- **WHEN** 回调签名校验失败
- **THEN** 该次 `receive` 按既有错误语义拒绝，不产生有效记录

#### Scenario: 订阅生命周期沿用既有机制

- **WHEN** 订阅被对账（reconcile）、取消或其 connection 被断开
- **THEN** 行为与运行时既有 trigger 语义一致（`active: false` 取消、断开拒绝与清理），无 provider 专属旁路

### Requirement: 商户结算只读动作面最小集

`wechatpay` SHALL 提供交易账单下载与交易查询 action；`alipay` SHALL 提供对账单下载与交易查询 action，均为 `operationType=read`。字段命名与帮助文案 SHALL 指向官方商户平台/开放平台指引（provider 原生口径），日终渠道对账的账单数据面以这些 action 供给。

#### Scenario: 拉取一日账单

- **WHEN** 以锚点客户商户凭证调用账单下载 action 并指定一个自然日
- **THEN** 返回该日渠道账单数据（或官方异步下载语义的等价结果），全程无写请求发生

#### Scenario: 交易查询可用

- **WHEN** 以交易号或时间范围调用交易查询 action
- **THEN** 返回对应交易状态与金额信息，用于与中台台账核对

### Requirement: WMS 接入走同一载体的骨架契约

客户 WMS 接入 SHALL 走同一条 in-tree additive 载体，骨架契约为：库存快照只读 action（库存查询/单据状态，`operationType=read`）+ 出入库事件 trigger（WMS 支持 webhook 则用 webhook，否则 poll）；编排层对 WMS 零写面（中台→WMS 单向写由客户既有链路承担）。锚点客户 WMS 品牌与接口形态确认前 SHALL NOT 实现任何 WMS provider；确认形态为非 HTTP API 时 SHALL 先立 SDK 能力缺口评估并另行立项。

#### Scenario: 未确认品牌时目录无 WMS provider

- **WHEN** 锚点客户 WMS 品牌与接口形态尚未确认
- **THEN** 目录不新增任何 WMS provider，ERP 侧对该绑定如实报 NOT_WIRED 并给出替代路径说明

#### Scenario: 形态确认后的接入路径

- **WHEN** 锚点客户确认 WMS 为 HTTP API 形态
- **THEN** 按本载体以全新目录另立 change 实现，动作面限于骨架契约（只读快照 + 事件回调），并以「出库指令投递 → 作业完成事件回传 → 库存读对平」一轮闭环为验收

#### Scenario: 非 HTTP 形态先评能力缺口

- **WHEN** 确认的形态为中间表/文件交换等非 HTTP API
- **THEN** 先产出 SDK 能力缺口评估并另行立项，不在本载体内强行实现

### Requirement: 金蝶增补归 upstream、本仓零触碰

金蝶云星空既有 provider（`src/providers/kingdee/**`）SHALL 保持零修改：凭证推送、往来、发票回写的可用性经既有 12 个通用 formId action 评估（`save`/`submit`/`audit`/`push_records` 链 + `query_records`/`query_report` 读面）；缺口（开票直连、凭证模板自动生成、银企直连等）SHALL 列为 upstream 增补项清单，以 upstream PR 另行提出；本 fork SHALL NOT 复制同 service id 的 provider 副本或在 fork 侧实现增补。

#### Scenario: 评估零代码

- **WHEN** 完成凭证推送/往来/发票面评估
- **THEN** `src/providers/kingdee/**` 无任何改动，评估结论与 upstream 增补项清单记录在本 change 工件内

#### Scenario: 缺口不入 fork

- **WHEN** 某缺口（如开票直连）经锚点实例验证被确认为必需
- **THEN** 它以 upstream PR 候选项记录并在 ERP 线挂账跟踪，不在 fork 侧实现或复制 provider
