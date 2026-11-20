# WMS 接入骨架契约（实现挂起）

状态：**骨架先行，实现挂起**。锚点客户 WMS 品牌与接口形态确认前，本仓不新增任何 WMS provider（openspec change `add-supply-chain-provider-onboarding`，design D6 / spec `provider-onboarding`）。品牌与形态确认后，按本文档 + 同一载体（`src/providers/<service>/` 全新目录，见该 change design D1）另立 change 实现。

## 载体

与既有 provider 同一条 in-tree additive 载体：

- `src/providers/<wms-service>/definition.ts` + `actions.ts` + `executors.ts`（+ trigger 文件），随 `npm run generate:catalog` 进入目录与执行注册表；
- 凭证形态 `custom_credential`（WMS API key/token 等，按厂商实际），BYOK，凭证不出库；
- 部署级不启用时走既有 `actionPolicy` / `allowedTriggers` 收口，零代码。

## 动作面骨架（全部 `operationType=read`）

编排层对 WMS **零写面**：中台 → WMS 的单向写（出库指令等）由客户既有链路承担，本 provider 不提供。

1. **库存快照查询**（`inventory_snapshot`）：按仓库/货主/时间拉取库存快照，输出 SKU、批次、数量、仓位；日终对账以快照为准。
2. **单据状态查询**（`order_status`）：按出库单号查询作业状态（已接收/拣货中/已发货/异常），供中台跟踪与对平。

## Trigger 骨架

**出入库事件**：WMS 支持 webhook 则用 integration trigger（webhook 优先），否则 poll trigger（轮询单据状态增量）。事件面至少覆盖：出库单作业完成、入库单收货完成、库存调整。验签按厂商机制在 `receive` 内完成，幂等（dedupeKey 取事件 id），订阅/对账/取消沿用运行时既有 subscription 语义（`src/triggers/`），零新迁移。

## 验收判据（一轮闭环）

> 出库指令投递 → 作业完成事件回传 → 库存读对平

1. 中台既有链路投递出库指令后，该单在 WMS 侧状态可经 `order_status` 查询；
2. 作业完成事件经 trigger 落记录（验签通过、幂等去重生效、伪造签名被拒）；
3. 事件后的 `inventory_snapshot` 与中台台账对平（同一时点差异可解释）。

## 形态确认后的分支

- **HTTP API 形态**：按本文档骨架直接另立 change 实现；
- **非 HTTP 形态**（中间表/文件交换等）：现行 1568+ provider 全为 HTTP 形态、`src/triggers` 无该形态先例，须先产出 SDK 能力缺口评估并另行立项，不在本载体内强行实现。

## 前置依赖（ERP 线挂账）

锚点客户 WMS 品牌、接口形态、凭证发放方式（Open Questions 2）；确认前 ERP 侧对该绑定如实报 `NOT_WIRED` 并给出替代路径说明。
