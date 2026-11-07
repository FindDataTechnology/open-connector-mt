## 1. 数据结构与存储（两方言 + 三方实现）

- [x] 1.1 新增 `migrations/0019_pat_scope_grants.sql` 与 `migrations/postgresql/0019_pat_scope_grants.sql`（同文）：`alter table runtime_tokens add column purpose text;`、`alter table runtime_tokens add column parent_token_id text;`、`create index if not exists runtime_tokens_parent on runtime_tokens (parent_token_id);`。验证：两方言对空库与既有 0018 库各跑一次迁移，`pragma table_info` / `\d runtime_tokens` 均见两列，重复执行不报错。
- [x] 1.2 【upstream-touched】`src/server/storage/runtime-sql.ts` 行映射补 `purpose`、`parentTokenId`（走既有 `readOptionalString`）。验证：既有 store 用例全绿，新增映射断言。
- [x] 1.3 【upstream-touched】`src/server/storage/runtime-token-service.ts`：`createToken` 的 `policy` 之外补 `purpose` / `parentTokenId` 可选参数并透传；撤销走 `revokeToken` 内的父链级联（深度封顶，store 接口零改动——见 design D5）。验证：`runtime-token-service.test.ts` 加「父撤销连带子（含孙）」与「返回父是否存在」两例，8/8 通过。
- [x] 1.4 【upstream-touched】`src/server/storage/{sqlite,postgres,d1}/runtime-store.ts` 三方言写入/读取两列（insert 占位符 12→14）。验证：`src/server/storage` 全量 163 passed / 20 skipped，迁移清单用例已补 0019。

## 2. 铸造端点收范围（fork-new）

- [x] 2.1 `src/server/tenancy/tenant-routes.ts` `POST /api/tenant/pats` 接受 `{name, purpose?, allowedActions?, allowedConnections?}`；缺省空保持既有全权语义。验证：`tenant-routes-scope.test.ts`「keeps the unscoped response … byte-identical」——响应键恰为 `id/name/token`，落库两个白名单为空；body 走 `readJsonBody`（畸形 JSON 不再被当成空范围铸出全权令牌）。
- [x] 2.2 铸造期可满足性校验：`allowedActions` 每条规则须命中目录至少一个动作（`catalog.actionsById` + 按 provider 前缀集判定 `service.*`），`allowedConnections` 每个 id 须属本租户现存连接（`connections.listConnections()` 受 runWithTenant 约束）。验证：两条用例各返回 400 `invalid_scope` 且 `createToken` 未被调用；`blockedActions`/`allowedProxies`/`allowedTriggers` 一律 400（范围只收两个白名单）。
- [x] 2.3 同名重铸取并集并吊销旧令牌。验证：用例断言列表仅剩一枚、新令牌 `allowedActions`/`allowedConnections` 为并集、旧令牌以 `{ cascade: false }` 退场（承接其子令牌，见 D5）。匹配键 `(tenantId, name, parentTokenId)`——v1 一租户一身份，故等价于「同一身份同名」。
- [x] 2.4 `TENANCY=off` 路径同样走范围校验（引导租户 `local-admin`）。为实现契约，租户路由改为「有 tenantStore 即挂载」（`connect-server.ts`/`connect-app.ts` 透传 `tenancy`），`TenantRouteOptions.hooks` 变可选；off 档由 admin 凭据作引导租户主权（`api/auth.ts` 公开路径分支也标记 admin bearer）。验证：两条 off 档用例——admin bearer 铸出 `tenantId=local-admin` 的范围 PAT；非法规则同样 400。
- [x] 2.5 `GET /api/tenant/pats` 响应加 `purpose`、范围摘要字段（`allowedActions`/`allowedConnections`）与 `parentTokenId`（无明文）。顺带修掉一处既有跨租户泄漏：原实现只按 `kind` 过滤、不按租户，任何身份都能看到别租户 PAT 的 id/name；现按 `principal.tenantId` 过滤，DELETE 亦按租户对齐（他租户 id 与不存在同形）。验证：用例断言只见本租户、JSON 不含 `oct_`/哈希。

## 3. 衰减铸造（PAT 鉴权派生）

- [x] 3.1 `POST /api/tenant/pats` 增加 `Bearer user_pat` 鉴权分支；请求范围须为调用令牌范围子集（父规则集合覆盖子规则：`*` 全放、`svc.*` 前缀、否则精确 id），越界 403 `scope_not_attenuated` 且不静默裁剪。缺省字段继承父范围（空 allowlist = 不限制，省略若当空写就等于放宽）；父令牌的 `blockedActions`/`allowedProxies`/`allowedTriggers` 一并继承，父子策略只能变窄。验证：五条用例（子集成功 / 动作越界 / 连接越界 / 全权父派生任意子集 / 继承父级黑名单）。
- [x] 3.2 派生令牌落库 `parent_token_id`，`purpose` 必填（400 `purpose_required`）。验证：用例断言 `parentTokenId=parent-1`、`purpose` 落库；缺 purpose 400 且不产生令牌。`service_pat` 不能铸 PAT（403），避免服务令牌代发凭据。
- [x] 3.3 撤销父令牌连带失效子令牌。级联在 `RuntimeTokenService.revokeToken` 内广度优先（深度封顶 4），`DELETE /api/tenant/pats/:id` 走默认级联。验证：服务层用例（父/子/孙全失效、旁系存活）+ 路由层 off/oidc 撤销用例；子令牌解析返回 undefined ⇒ 运行面 401。
- [x] 3.4 提权封口：派生令牌不可访问 admin 域、不可发起 OBO。admin 域由既有中间件按 `scope === "admin"` 拒绝非 admin 主体；OBO 仅 `service_pat` 可达，`user_pat` 带 `x-oo-connector-actor-sub` 仍按自身租户执行。验证：两条用例（`GET /api/runtime-policy` 403；带 actor 头的 `/api/tenant/session` 仍报 `t1`/`user_pat`）。

## 4. 范围自省面（fork-new 只读端点）

- [x] 4.1 新增 `GET /api/tenant/scope-explain?actionId=<id>`，以 `policyOf(context)`（部署+运行时+令牌三层求交）求值，返回 `{actionId, provider, operationType, allowed, code, checks[]}`；未知动作 404 `unknown_action` 与被拒 200 可区分。验证：三条用例——令牌白名单未命中（`source=token`/`allow_miss`）、部署级屏蔽（`source=deployment`/`block_match`）、未知动作。
- [x] 4.2 新增 `GET /api/tenant/catalog-coverage?provider=&operations=read,write`，按类返回 `{operation, covered, actionCount, executableActionCount}` 与 `gaps[]`（`covered` = 该 provider 该类有本地可执行动作）；未知 provider 404 `unknown_provider`，非法操作类 400。验证：四条用例（读写齐备 / 写面缺口 / 未知 provider / 无任何连接也照答）。
- [x] 4.3 只读保证：两端点均不执行动作、不写运行记录、不改令牌状态。验证：用例断言 `actions.run` 未被调用、无撤销、令牌列表快照前后一致。注意口径：以 PAT bearer 调任何端点时中间件在鉴权阶段即刷新 `last_used_at`（上游既有行为），故「`last_used_at` 不变」只在会话主体下成立——读取本身不额外触碰令牌。

## 5. 控制台与收口

- [x] 5.1 用户面板 PAT 卡显示 `purpose` 与范围摘要（「N 条动作规则 · M 个服务 · K 个连接」），全权令牌显式标注「全权令牌」并加醒目标记样式，逐枚撤销，六语言文案齐配。验证：`patScopeLabel`/`patScopeClass` 单测（全权 / 有范围 / 仅连接限制三形态）+ 服务端列表契约用例（含「已撤销即不在列表」）。未走浏览器 e2e：本页静态渲染不跑 effect，卡片实数据只在浏览器内出现。
- [x] 5.2 门禁：`oxlint` 0 警告 / `node scripts/typecheck.ts`（src+scripts+examples）干净 / `vitest run` 全量 **3578 passed, 20 skipped**（286 文件，1 skip）；两方言 store 用例已覆盖 0019 两列与迁移清单。**注意**：`npm run fix-check` 里的 `oxfmt .` 会把 10 个与本次无关的既有文档（`CONTEXT.md`、`openspec/specs/*`、`openspec/changes/archive/*`、`.github/workflows/publish-tcr.yml`）重排甚至改坏语义（`no_auth`→`no*auth`）——这是基线既有的 `format` 红，非本变更引入；已 `git checkout --` 还原，未混入提交。另修掉一处与日历赛跑的上游用例（`oauth-flow-service.test.ts` 里 `expiresAt` 写死 2026-10-30，已改相对时间）。
- [x] 5.3 `openspec validate scoped-pat-grants --strict` → valid；`git diff --stat` 确认 `src/core/action-policy.ts`、`src/mcp.ts`、`src/server/actions/action-runner.ts`、`src/providers/**` 零改动。upstream-touched 实际集合：`api/auth.ts`(+5)、`storage/runtime-{sql,token-service}.ts`、三方言 `runtime-store.ts`、`connect-{server,app}.ts`、`connector-runtime.ts`（均为必要接线）。
- [x] 5.4 已把备选触发条件写进 design.md D2：消费侧实施时若拿不到 `actionId`（如服务端直接代调），在本 change 内追加「action-runner 结果只读 scope 字段」任务并标 upstream-touched，不另开 change；本次首选路径已实施，备选未触发。

## 6. 操作类范围（D6，消费侧落地时补记）

对侧（壹座 `add-connector-bindings`）的绑定声明粒度是 `(provider, operationType)`，而本 change 首版只有动作 id 规则：`kingdee.*` 无法表达「只读」（会一并授予 write/destructive），展开成动作 id 又撞 128 条上限且目录新增动作后静默失效。故在 ① 内补齐结构化范围，两 change 的铸造入参因此对齐。

- [x] 6.1 【upstream-touched】`src/core/action-policy.ts`：新增 `OperationType` / `OperationScope` 与 `TokenPolicy.allowedOperations?`；令牌层白名单改为「动作规则 ∪ 操作类元组」取并，判断「该层是否受限」也据二者是否同时为空（空的类白名单不等于不受限）。`checks` 中类命中以 `provider@operationType` 记规则名。验证：`action-policy.test.ts` 新增四例——单类只放该类（同 provider 的 read 被拒）、与动作规则并集、双空仍不受限、动作规则可覆盖类声明。
- [x] 6.2 `src/server/api/policy-input.ts`：新增 `readAllowedOperations`（provider 非空、禁空格/通配、operationType ∈ 闭集、稳定去重、128 条上限）；`readTokenPolicy` 统一解析，缺省为 `[]`（上游调用方不发该字段，语义即「无类授权」）。验证：`policy-input.test.ts` 15/15；畸形 `operationType` 在路由层返回 400 `invalid_input`。
- [x] 6.3 存储：`migrations/0020_runtime_token_operations.sql` 与 `migrations/postgresql/0020_runtime_token_operations.sql`（同文，`allowed_operations text not null default '[]'`）；`runtime-token-service` 记录/摘要/解析三处透传；三方言 store 读写与 `updatePolicy` 补齐（占位符 14→15）。验证：`src/server/storage` 全量 166 passed / 20 skipped，两方言迁移清单用例补 0020，旧行解码为 `[]`。
- [x] 6.4 铸造与衰减：`POST /api/tenant/pats` 接受 `allowedOperations`，可满足性按「目录存在该类动作」校验（未命中 400 `invalid_scope`）；衰减改为双形态覆盖——父规则 `*`/`provider.*` 覆盖子类声明，父类声明覆盖「该类下的单个动作规则」但不覆盖 `provider.*` 或另一类；子令牌未声明任何动作/类范围时继承父令牌两种范围（只写连接白名单不再导致继承父动作面）。`GET /api/tenant/pats` 与同名重铸并集一并带上 `allowedOperations`。验证：`tenant-routes-scope.test.ts` 31/31，新增五例（类范围铸造、不可满足类、畸形类 400、父规则派生类子令牌、类父令牌拒 write/`kingdee.*` 并接受单动作、类范围继承）。
- [x] 6.5 OpenAPI `TokenPolicy` 增 `allowedOperations`（对象数组，`operationType` 闭集），不列入 `required`，上游契约只增不改。验证：`openapi.test.ts` 22/22。
- [x] 6.6 门禁：`oxlint` 0 警告；`node scripts/typecheck.ts` 干净；`npx vitest run` **3590 passed / 20 skipped**（286 文件）；`openspec validate scoped-pat-grants --strict` valid。PGlite SaaS 用例一次偶发失败，单独运行与全量复跑均通过（既有时序抖动，非本次引入）。
