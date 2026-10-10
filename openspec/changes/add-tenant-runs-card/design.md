# add-tenant-runs-card — Design

## Context

见 proposal「Why」。事实锚点（HEAD `9c6b6c4`）：

- store 读取接口 `RunLogListInput` 已含 `tenantId` 过滤与 cursor（`src/server/storage/runtime-store.ts:33-42`），三方言实现同构——服务端只缺路由。
- `runs.value` 是整条 RunLog JSON（`action-runner.ts:199-217` 组装）：inputSummary/outputSummary 已服务端脱敏截断（`run-log-summary.ts:9-13,43-50`：敏感 key/Bearer/JWT/带凭据 URL → `[redacted]`，16KB/深度 4 上限），但混有 runtimeTokenId、tenantId、policy 快照。
- admin runs 页（`runs-page.tsx:185-291`）全字段展示含 runtimeTokenId 原文——租户面不能照抄。
- RunLog 有 `durationMs`、`startedAt`、`caller`、`connectionProfile`（`CredentialProfile`，含 displayName）等可直接投影的字段。
- OBO 语义：`runtimeTokenId = input.runtimeTokenId ?? tenantAudit.serviceTokenId`——代调时它是**服务方**的 service PAT id，不在本租户 PAT 集合内。

## Goals / Non-Goals

**Goals**：租户侧只读运行记录（隔离、投影、PAT 名映射）以最小服务端面落地；`/me` 一张收起式卡。

**Non-Goals**：分页/游标透出（store 支持但路由只取 20 条）；caller 维度过滤；runs 保留策略调整；admin 页复用改造。

## Decisions

### D1 路由与投影（`tenant-routes.ts`）

`GET /api/tenant/runs?limit=20`，`requireUser` + `runWithTenant` 限定（与 connections 同构，`tenant-routes.ts:277-287` 的既有模式）。调用 store `listRuns({ tenantId, limit })`（limit 钳制 1..20，缺省 20；cursor 不透出）。响应逐条投影：

```
{ startedAt, durationMs, ok, actionId, caller,
  connectionName: connectionProfile?.displayName ?? connectionId,
  errorCode, errorMessage, inputSummary, outputSummary, patName }
```

runtimeTokenId / tenantId / policy / connectionProfile 原文 / connectionId 不出路由边界（connectionId 仅在无 displayName 时折进 connectionName——id 形如 `service:connName`，本身是租户可见语义，非内部标识）。**投影在路由层做**而非序列化器——与 admin 面解耦，admin 序列化零触碰。

### D2 PAT 名映射（服务端一次性 join）

路由内取本租户 PAT 列表（既有 tenant-store PATs 读路径）建 `id → name` 映射，逐 run 查 `runtimeTokenId`；无匹配（OBO 服务方令牌、已删除令牌）统一回退中性占位键 `tenant.runs.externalToken`。**映射在服务端做**：PAT 名对租户本就可见，客户端 join 需要把 runtimeTokenId 出边界——违背投影原则，否决。

### D3 运行记录卡（`user-page.tsx`）

`RunsCard` 置于 `TestRunCard` 之后：`<details>` 折叠（同免鉴权组的既有样式类），summary = 标题 + 计数徽章；展开时才首拉，之后手动刷新按钮重拉（不轮询、不随其它卡刷新联动）。行内主列：时间+耗时、成败点（复用 `StatusDot`）、actionId、caller、连接名、patName；失败行附 errorCode/errorMessage；inputSummary/outputSummary 以行内展开（`<details>` 嵌套或点击态）呈现 pretty JSON——数据已在手，不发额外请求。

### D4 测试与 i18n

- 路由单测（挂既有 `tenant-routes` 测试文件族）：租户隔离（A 不见 B）、投影字段集断言（响应无 runtimeTokenId/tenantId/policy 键）、OBO runs 含于 actor 租户、limit 钳制、PAT 名映射与外部令牌回退。
- vitest 静态渲染：卡默认收起带计数、置底（DOM 序在试跑卡后）、展开渲染行结构、失败态 errorCode 展示。
- 新 locale 键：`tenant.runs.title / empty / refresh`（复用 common.refresh 则只加前两者）、`tenant.runs.externalToken`、`tenant.runs.input`/`tenant.runs.output`——六语言全配。

## Risks / Trade-offs

- **20 条上限无翻页**：长调试会话看不到更早记录——grill 定案接受（全量查询是管理台职责）；Non-goals 记录重开条件同「迷你控制台」触发线。
- **PAT 名映射多一次 PAT 列表读**：每请求一次轻量读，租户 PAT 数量级小（个位-十位），可忽略；不缓存（PAT 撤销后需即时反映为占位）。
- **value 里 RunLog 字段演进**：上游加字段默认不进投影（白名单式投影天然防泄漏），反向漏新字段的风险记入 CONTRIBUTING 心智即可。
