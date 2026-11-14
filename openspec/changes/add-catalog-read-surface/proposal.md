# add-catalog-read-surface

## Why

连接器的目录（1570 provider / 一万余 action / 每个 action 的读-写分类与可执行性）是所有消费面判断「这个包声明的外部系统到底能不能兑现」的唯一真源。今天**没有任何不绑租户的身份面能读它**：

- `/api/tenant/catalog-coverage` 与 `/api/tenant/scope-explain` 先过 `requireUser`，而 `resolveServicePat` 对**没有 actor 头**的服务令牌直接返回 undefined（`src/server/tenancy/tenant-auth.ts:209-214`，注释原文：「没有 actor 头的服务令牌没有自己的租户，按未认证处理」）⇒ 服务令牌读这两个面必然 401。
- `/v1/providers`、`/v1/actions`、`/v1/apps` 是 runtime 域，要 runtime token（`readAuthScope`：`/v1/*` ⇒ runtime）。
- `/api/providers`、`/api/actions` 是 admin 域，要部署级 admin token——那是能铸 PAT、能跨租户读写的最高权限凭据。

于是谦面（facet，pack 市场/供给面）要想在**上架时**告诉作者「你声明的 `kingdee` 写面目录里没有」，或在上架后告诉客户「这个包需要 3 个外部系统，连接器支持 2 个」，只有三条路：把 admin token 交给市场服务；伪造一个 actor 身份去挤进租户语义；或者放弃。三条都不该走。

目录数据本身**不是租户数据**（`catalog-coverage` 的实现只读 `options.catalog.providers`，一次都不碰租户或连接），所以正确的问题不是「该给谦面哪个租户」，而是「目录读面本来就该有不绑租户的一档」。

## What Changes

- **新增 fork 侧只读目录面 `/api/catalog/*`**（`src/server/catalog-routes.ts`，全新文件），提供：provider 列表与详情、按 `(provider, operationType)` 的覆盖度（与 `catalog-coverage` 同口径）、单条 action 的归属与类。**只读、无副作用**：不执行动作、不写 run、不铸/不吊销令牌、不返回任何连接、租户、凭证或 run 数据。
- **env 门控，默认关闭**，镜像本仓既有的 additive + env-gated 纪律（`OOMOL_CONNECT_CROSS_MINT_ORIGINS` 的同一形状）：
  - 未设置（默认）⇒ 路由**不注册**，`TENANCY=off` 行为与上游逐字节兼容。
  - `OOMOL_CONNECT_CATALOG_READ=public` ⇒ 无需凭据（部署者显式选择公开目录）。
  - `OOMOL_CONNECT_CATALOG_READ=service` ⇒ 需要 `OOMOL_CONNECT_CATALOG_READ_TOKEN` 的 Bearer；这是一枚**独立于 admin/runtime 的最小权限凭据**，只开这一个面。
- **不改认证内核**：不碰 `tenant-auth.ts` 的 `resolveServicePat`，不给 `service_pat` 开「无 actor」档，不动 `/api/tenant/*` 的语义。新面自带一个最小的凭据判断，与既有域并列而不是嵌进租户解析链。
- **文档**：`docs/runtime-api.md` 增一节说明该面存在条件、两种模式与返回形状；`README` 的部署选项提及该开关。

## Capabilities

### New Capabilities

- `catalog-read`: 不绑租户的只读目录面——可读什么、绝不返回什么、两种模式各自的门、以及与既有 `catalog-coverage` 的口径必须一致。

### Modified Capabilities

（无。既有租户面与 runtime 面语义一律不变。）

## Non-goals

- **不放宽 `service_pat` 的无 actor 读**：那会改认证内核（`resolveServicePat` 是 OBO、consent、租户解析的汇合点），风险与收益不成比例；本变更用一枚专用凭据绕开这个汇合点。
- **不做租户数据的任何匿名/服务投影**：连接列表、PAT 列表、run 日志、私有来源配置一律不在此面，且这不属于「后续可加」的范畴——它们是租户数据。
- **不做写面**：不提供任何 provider/action 的修改、启用、策略设置入口。
- **不做分页/搜索优化以外的目录增强**：不在此变更里加「推荐 provider」「能力缺口报告」等策展逻辑，那些属于消费方（谦面/壹座）。
- **不改 `/api/tenant/catalog-coverage` 的鉴权**：它服务的是「某个用户自己的连接能否兑现」，与「目录有没有这个能力」是两个问题，继续要用户身份。
- **不做缓存与 CDN 配置**：只读面沿用既有响应头策略，不新增缓存层。

## Impact

- **代码**：`src/server/catalog-routes.ts`（fork-new）、`src/server/connect-server.ts` 增一处条件挂载（**upstream-touched**，一行 import + 一段 `if`）；`src/server/tenancy/constants.ts` 旁新增读取 env 的小函数（fork-new 文件或追加，见 design D2）。
- **API**：新增 `/api/catalog/*`，仅在 env 开启时存在；未开启时与上游逐字节一致。
- **DB / 迁移**：无。
- **安全面**：新增一个只读网络面。默认关闭；`public` 模式下任何人可枚举 provider 与 action 元数据（均为 Apache-2.0 上游目录数据，无租户事实）；`service` 模式下多一枚需单独轮换的凭据。
- **上游可合并性**：新增文件 + `connect-server.ts` 一处条件挂载。双周合并冲突面 = 一行 import 与一处 if 块；投递 upstream PR 的可行性在 design D5 里给出结论（倾向不投递：上游无多租户消费方，公开目录面属于 fork 的产品决定）。
- **验收**：未设置 env 时 `/api/catalog/*` 404 且全套既有用例零改动通过；`public` 模式匿名 200；`service` 模式无令牌 401、错误令牌 401、正确令牌 200；返回体断言不含任何连接/租户/run/凭证字段；覆盖率口径与 `/api/tenant/catalog-coverage` 对同一 provider 逐字段相等；`openspec validate add-catalog-read-surface --strict`。

## 上游文件触碰（upstream-touched）

- `src/server/connect-server.ts`：**必须触碰**，因为路由只能在那里注册（`createLocalAuthMiddleware` 之后的路由表由它持有）。触碰形态限定为：一行 import + 一段 `if (config.enabled) registerCatalogRoutes(app, ...)`，不修改任何既有 handler 或中间件顺序；且该 `if` 在 env 未设置时等价于不存在（`isPublicPath`/`readAuthScope` 均不改）。
- 其余全部为 fork-new 文件，零既有文件修改。
