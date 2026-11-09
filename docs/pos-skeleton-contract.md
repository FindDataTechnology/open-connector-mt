# 门店 POS 接入骨架契约（实现挂起）

状态：**骨架先行，实现挂起**。锚点客户的门店 POS 品牌与接口形态确认前，本仓不新增 POS provider
（决策见 `docs/adr/0002-no-generic-http-provider.md`）。品牌确认后按本文档 + 同一载体
（`src/providers/<service>/` 全新目录）另立 change 实现。

消费方：ERP 线餐饮连锁连接器包的 `pos-sales` 绑定（`provider: "pos"`, `providerRole: true`,
`allowOperations: ["read"]`, `optional: true`）。该绑定是**角色形态**——目录里不需要同名 provider，
客户在连接器卡片选定实际系统；但客户能选的系统必须先在目录里存在，本骨架就是为"让它存在"定形。

## 载体

与既有 provider 同一条 in-tree additive 载体：

- `src/providers/<pos-service>/definition.ts` + `actions.ts` + `executors.ts`（+ trigger 文件），
  随 `npm run generate:catalog` 进入目录与执行注册表；
- 凭证形态 `custom_credential`（厂商 API key / OAuth / 门店 token，按实际），BYOK，凭证不出库；
- **禁止**从凭证或动作入参里取 base URL（见 ADR 0002 理由 1）：端点必须是代码字面量，
  `skipDnsValidation` 若确有必要，理由必须写进 executors 注释与归化 PR（沿 wechatpay 先例）。

## 动作面骨架（全部 `operationType=read`）

编排层对 POS **零写面**：下单/改单/退款等写操作发生在门店自己的系统与渠道侧，中台只读。

1. **销售流水查询**（`list_sales`）：按门店 + 营业日（或时间窗）拉取订单/流水，输出
   订单号、时间、金额、支付方式、退款标记。日结对账以流水为准。
2. **门店信息查询**（`list_stores`）：门店编码、名称、时区、营业日切分口径——日结必须知道
   "这个店的一天"从几点到几点，否则跨时区连锁的对账口径会错。
3. **商品/品类映射查询**（`list_items`，可选）：SKU/条码与门店侧商品编码的映射，供中台
   与自身台账对位；无此面时上游以导出文件补。

> 面与动作的对应关系必须写进 `fd-erp-vertical-templates/docs/connector-binding-surfaces.md`，
> 那是防"类级覆盖绿灯但面对不上"的门（2026-11-08 踩过 meituan / shopify 两例）。

## Trigger 骨架

**交易事件**（可选，视厂商能力）：退款、撤单、日结完成。支持 webhook 则 integration trigger
（webhook 优先），否则 poll（按营业日增量拉取）。验签在 `receive` 内完成、幂等（dedupeKey 取
事件 id 或 订单号+版本），订阅/对账/取消沿用运行时既有 subscription 语义，零新迁移。

## 验收判据（一轮闭环）

> 日结流水读回 → 与中台账对平 → 差异可解释

1. 某门店某营业日的流水经 `list_sales` 读回，条数与金额合计与该店后台导出**逐笔一致**
   （容差为零；不一致必须能归因到退款/撤单/时区这三类之一）；
2. `list_stores` 返回的营业日切分与对账口径一致（跨时区门店不产生"半天被算两次"）；
3. 有 trigger 时：一笔退款事件落记录（验签通过、幂等去重生效、伪造签名被拒）。

## 形态确认后的分支

- **HTTP API 形态**：按本文档骨架直接另立 change 实现；
- **仅导出文件形态**（不少餐饮 POS 只给 CSV/Excel）：本仓不提供，沿 ERP 线既有的
  "导出文件替代通道"处理；若要做，须先产出能力缺口评估并另行立项（同 WMS 契约的非 HTTP 分支）；
- **PDA/私有协议形态**：同上，不在本载体内强行实现。

## 前置依赖（ERP 线挂账）

锚点客户的 POS 品牌、接口形态（API / 导出文件 / PDA）、凭证发放方式、营业日切分规则。
确认前，ERP 侧该绑定报 `unmapped`（客户未选定）或选定后报 `unwired`/`missing`，
状态面如实显示，不冒充已接通。
