## Why

多租户实现里 `service_pat` 的**消费侧**已完成（`tenant-auth.ts` 的 OBO 解析、`SERVICE_OBO` 三档、actor 头与 consent 表），但**发放侧缺失**：仓库里没有任何路由能铸造 `kind='service_pat'` 的令牌。admin 域的 `POST /api/runtime-tokens` 造出的是无 `kind` 的 legacy token，在 `TENANCY=oidc` 下被解析器明确拒绝（"plain runtime tokens carry no tenant authority in MT mode"）。结果是谦面（facet agent 服务）这条消费平面虽然规格与代码都就绪，实际无法拿到可用凭据——代调能力形同虚设。

## What Changes

- **admin 域新增 service PAT 发放端点**：`POST /api/runtime-tokens` 接受可选 `kind: "service_pat"`（或新增专用端点），铸造的令牌不带 `tenant_id`、`kind='service_pat'`，明文仅本次响应返回。
- **列表/撤销纳入既有 runtime-token 面**：service PAT 出现在运行时令牌列表中（带 `kind` 标识），可被 admin 撤销；撤销即时生效。
- **面板展示 service PAT**：运行时令牌页显示 `kind`，使 operator 能区分 legacy / user_pat / service_pat。
- **文档化消费契约**：在 README 或接入指南里写明谦面式调用方式——`Authorization: Bearer <service_pat>` + `x-oo-connector-actor-sub: <已登记身份 sub>`，以及 `SERVICE_OBO` 三档的行为差异。

非目标：不做 service PAT 的 self-service 发放（仍由 admin 铸造，符合"服务主体"语义）；不改 OBO 解析逻辑；不做 consent 管理 UI；不动 user_pat 路径。

## Capabilities

### New Capabilities

（无新增能力目录——本 change 在既有 `tenant-auth` 能力名下**新增**一条 requirement；该能力的 spec 尚未归档到 `openspec/specs/`（`add-multi-tenancy` 未归档），故 delta 只能走 ADDED。）

### Modified Capabilities

（无——`service_pat` 的**行为**要求（OBO 三档、actor 校验）已在 `add-multi-tenancy` 的 tenant-auth delta 中，本 change 只**新增**发放与撤销的要求，不改既有条目。）

## Impact

- **上游文件触碰**：`src/server/connect-server.ts` 的 `createRuntimeToken` / 令牌列表投影需要接受并透出 `kind`。**触碰不可避免**：令牌铸造与列表的唯一入口就在这里，另起一套并行端点会让"运行时令牌管理"出现两个互不相干的清单。改动为增量（可选参数 + 投影字段），`TENANCY=off` 下行为不变。
- **fork-new 文件**：若选择独立端点，新路由放 `src/server/tenancy/tenant-routes.ts`（该文件已是 fork-new），但 admin 域令牌列表仍须投影 `kind`，所以 `connect-server.ts` 的最小触碰仍在。
- **测试**：`runtime-token-service` 的 store 测试已覆盖 `kind` 往返；新增路由级测试（铸造→以 actor 头调用→审计落 service/actor）。
- **消费方**：谦面接线（后续 change）依赖本端点产出凭据。
