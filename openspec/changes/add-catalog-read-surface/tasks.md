# Tasks — add-catalog-read-surface

## 1. 配置与开关（fork-new）

- [x] 1.1 新增 `src/server/catalog-read-config.ts`：`readCatalogReadConfig(env)` 纯函数返回 `{mode: "off"|"public"|"service", token?: string}`。未设置 ⇒ `off`；`public`/`service` 原样；其它取值抛错并列出允许值；`service` 且令牌为空 ⇒ 抛错。验证：`src/server/catalog-read-config.test.ts` 五条（未设置 / public / service+令牌 / 非法取值 / service 缺令牌），每条断言 mode 或抛错消息。
- [x] 1.2 挂载点改为条件注册 + 一行启动日志：`catalog read surface: <mode>`。**本任务触碰上游文件 `src/server/connect-server.ts`**（一行 import、一段 if、一行日志），不改既有 handler 与中间件顺序。验证：未设置 env 启动后 `GET /api/catalog/providers` 404，且既有 `connect-server.test.ts` 全绿；启动日志出现 `off`。

## 2. 覆盖度唯一口径（fork-new 抽取 + 一处 upstream-touched）

- [x] 2.1 新增 `src/server/catalog-coverage.ts` 的 `coverageOf(provider, operations)`，语义与 `tenant-routes.ts:644-680` 的内联实现逐字等价（`covered = executableActionCount > 0`，`gaps = 未覆盖的类`）。验证：新增用例对若干 provider 断言三个计数与 gaps。
- [x] 2.2 `src/server/tenancy/tenant-routes.ts` 的 `catalog-coverage` handler 改为调用 `coverageOf()`。**本任务触碰上游文件**，改动限于替换内联计算，不改鉴权、不改响应形状。验证：既有 `tenant-routes-scope.test.ts` 与新增的等价用例全绿；响应对同一输入逐字段不变。
- [x] 2.3 口径等价用例：对 5 个真实 provider（含一个 write 类 `covered=false` 的）比对 `/api/catalog/coverage` 与 `/api/tenant/catalog-coverage` 的 `covered` / `actionCount` / `executableActionCount` / `gaps`。**先证明能红**：临时把 `coverageOf` 的 `covered` 判据改成 `actionCount > 0`，该用例必须红，改回后绿。

## 3. 只读端点（fork-new）

- [x] 3.1 新增 `src/server/catalog-routes.ts`：`GET /api/catalog/providers`（列表：service / displayName / categories / authTypes / actionCount）。验证：public 模式下条数等于 `catalog.providers.length`，抽样三条字段齐全。
- [x] 3.2 `GET /api/catalog/providers/:service`：单 provider 元数据；未知 service ⇒ 404 `unknown_provider`。验证：已知 200、未知 404 且错误码为 `unknown_provider`（不是空覆盖度）。
- [x] 3.3 `GET /api/catalog/coverage?provider=&operations=`：复用 2.1；`operations` 非法 ⇒ 400 `invalid_input`。验证：与 2.3 的等价用例共用断言；非法 operations 返回 400。
- [x] 3.4 `GET /api/catalog/actions/:actionId`：只回 `{actionId, provider, operationType, executable}`，不回 input schema、不回策略判定（`allowed` 属于运行时面，见 design D4）。未知 action ⇒ 404 `unknown_action`。验证：字段集合断言（`Object.keys().sort()` 逐字比对），未知 404。
- [x] 3.5 写动词：`POST/PUT/PATCH/DELETE /api/catalog/*` 一律 405。验证：四个动词各一条。

## 4. 模式门（fork-new）

- [x] 4.1 `public` 模式：匿名 200。`service` 模式：无 Authorization ⇒ 401 且错误码机器可读；admin 令牌 ⇒ 401；runtime 令牌 ⇒ 401；正确专用令牌 ⇒ 200。比较用常量时间（`timingSafeEqual`，等长后才比）。验证：六条用例；断言 401 而不是 404（「被门挡」与「没有这个面」必须可分）。
- [x] 4.2 门的隔离性：admin 令牌在**既有** admin 面仍 200（本面不为它扩权，也不因它被拒而影响别处），专用令牌在 `/v1/*` 与 `/api/tenant/*` 上 401/404 如常。验证：两条交叉用例。

## 5. 泄漏边界

- [x] 5.1 序列化四个端点的响应，扫描键名与键值断言不含 `connection` / `tenant` / `identity` / `pat` / `run` / `secret` / `credential` 字样（含嵌套）。验证：扫描用例；**先证明能红**：临时给 provider 详情塞一个 `connections: []` 字段，用例必须红。
- [x] 5.2 同一 provider 对两个不同令牌主体的响应逐字节相等（本面无「我的/你的」）。验证：两次请求体 `JSON.stringify` 相等断言。

## 6. 文档与验收

- [x] 6.1 `docs/runtime-api.md` 增一节：存在条件（默认无）、两种模式、四个端点、绝不返回什么（租户/连接/PAT/run/凭证）、以及「目录事实 vs 策略判定」的界线（`allowed` 不在本面）。
- [x] 6.2 `README.md` 的部署选项表提及该开关与两档取值。
- [x] 6.3 全量 `npx vitest run` 绿；`npm run fix-check` 绿（跑完核对是否有无关文件被 oxfmt 重排，有则还原）。
- [x] 6.4 `openspec validate add-catalog-read-surface --strict` 过；归档时对账 totals 与 delta 需求条数一致（`+ 5 added`）。
- [x] 6.5 记一笔消费方接入（不在本 change 实施）：谦面侧接上后，发布时对 `connector_bindings` 做**建议性**覆盖度提示（不阻塞发布），pack 详情显示「需要 N 个外部系统，连接器支持 M/N」。该消费方改动在 paas 仓另立 change。

## 实施注记（2026-11-13 落地）

- **挂载点在 auth 中间件之前**：`connect-server.ts` 里在 `app.use("*", createLocalAuthMiddleware(...))` 之前条件注册。理由是门必须在 handler 内自带——把 `/api/catalog/*` 写进 `isPublicPath`（无鉴权）或某一 `readAuthScope` 域（顺带扩权）都会静默改变既有面的语义。未启用时连路由都不存在，中间件一行未改。
- **常量时间比较**：`timingSafeEqual`，长度不等直接 false（只泄露长度）。用例专门钉了 `tok_catalogextra` 这种前缀命中但长度不同的串必须 401。
- **`service` 缺令牌 = 启动期抛错**，不是「恒不匹配」。`readCatalogReadConfig` 是纯函数（入参 env 快照），所以这四条能在单测里跑，不必起进程。
- **唯一口径真的收到了一个函数**：`coverageOf()` 同时服务租户面与目录面。同时把 `tenant-routes.ts` 里那份 `readOperationTypes`/`operationTypes` 副本删掉改为 `parseCoverageOperations`——否则「类解析」这一层仍有第二份。
- **能红证明做了什么**：把租户 handler 改回「内联的、把 `actionCount > 0` 当 covered」的版本 ⇒ 等价用例红并点名 `catalogonly`（该 provider 的 `write` 类只有不可执行动作，是唯一能区分两种判据的形状，故在夹具里专门加了一个）。给 provider 摘要塞一个 `connections: []` ⇒ 泄漏扫描红。
- **首轮三次「注入不红」是真教训**：第一次改的是共享函数（两边一起变，当然不红），第二次夹具里每个类都还有可执行动作（两种判据同答案）。判据要红，必须让注入点落在**可能分叉的那一侧**，且夹具里要有**能区分两种实现的样本**。
- **全量 vitest**：3637 passed / 3 failed，三条全是 5000ms 超时（`catalog-index` 重生成目录、`provider-source-guards.*` 扫全仓 provider 源码），单独跑 10/10 绿、耗时 2.8s 左右。属全量并发下的负载型超时，非断言失败，与本变更无关（都不在 `src/server`）。
- **未投递上游 PR**（design D5 已记理由）；`connect-server.ts` 与 `tenant-routes.ts` 是本变更仅有的两处 upstream-touched。

## 实施注记续（2026-11-13，fix-check 与还原）

- **`npm run fix-check` 会重排一批与本次无关的既有文件**：本仓跑一次后 `git status` 从「1 个改动」变成 **25 个 M**，其中 21 个是 oxfmt 的格式化噪音（`CONTEXT.md`、`docs/adr/*`、`openspec/changes/archive/**`、`openspec/specs/{multi-tenancy,tenant-auth,tenant-console,tenant-mcp,scope-introspection}`、`src/core/action-policy.ts`、`src/providers/shopify_admin/actions.test.ts`、`src/server/api/policy-input.ts`、`web/src/ui.tsx` 等）。这与 paas 仓的既有结论同型：**跑完必须逐文件还原**，否则会把一次功能改动变成一次全仓格式化。
- **还原方式**：`git show HEAD:<path> > <path>`（不用 `git checkout --`，仓规禁）。判据是 `git status` 回到预期集合，且 `git diff --stat docs/quickstart.md` 仍显示别人的 3 行真实改动（说明没误伤）。
- **踩到的坑（记录以免重犯）**：还原脚本用 `for k in $KEEP` 做白名单，在 **zsh 下不在空格上分词**，白名单整体成了一个词，于是白名单里的文件也被还原了——包括本变更的三处编辑和另一会话在 `docs/quickstart.md` 的未提交改动。前者逐字重放，后者按还原前 `git diff` 的原文逐字补回（复原后 blob 哈希与还原前一致）。**跨 shell 写白名单循环要显式数组或用 `case`**，别依赖未加引号变量的分词行为。
- **最终校验**：`npx tsc --noEmit` 通过；`npx vitest run src/server/` 728 passed / 20 skipped；`openspec validate add-catalog-read-surface --strict` 通过。
