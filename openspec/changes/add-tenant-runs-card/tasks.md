# add-tenant-runs-card — Tasks

## 1. 服务端只读路由

- [x] 1.1 `tenant-routes.ts` 新增 `GET /api/tenant/runs?limit=20`：`requireUser` + `runWithTenant` 租户限定，调 store `listRuns({ tenantId, limit })`，limit 钳制 1..20、cursor 不透出。验证：路由单测——租户隔离（A 租户结果不含 B）、limit 钳制、缺省 20。
- [x] 1.2 路由层白名单投影（startedAt/durationMs/ok/actionId/caller/connectionName/errorCode/errorMessage/inputSummary/outputSummary/patName）；PAT 名服务端映射（本租户 PAT id→name，无匹配回退占位键）。验证：断言响应对象无 runtimeTokenId/tenantId/policy/connectionProfile 键；OBO runs（serviceTokenId 发起、tenant_id=actor 租户）含于 actor 租户结果且 patName 为占位。

## 2. 前端运行记录卡

- [x] 2.1 `user-page.tsx` 新增 `RunsCard` 置于 `TestRunCard` 之后：`<details>` 默认收起、summary 带条目计数、展开首拉 + 手动刷新按钮（不轮询）；行内时间+耗时/成败点/actionId/caller/连接名/patName，失败行 errorCode/errorMessage，inputSummary/outputSummary 点击展开 pretty JSON（不发额外请求）。`tenant-api.ts` 加对应调用。验证：vitest 静态渲染断言——默认收起带计数、DOM 序置底、行结构、失败态、摘要展开。
- [x] 2.2 `style.css` 纯追加运行记录卡样式（复用既有 user-card / 折叠组类，最小增量）。

## 3. 文案与 i18n

- [x] 3.1 新增 locale 键（tenant.runs.title/empty/externalToken/input/output，refresh 视复用情况）六语言全配。验证：既有 i18n 键完整性测试全绿。

## 4. 验收门

- [x] 4.1 全量 vitest 绿（服务端 + web，含既有 tenant-routes / user-page 测试无回归）；构建通过。
- [x] 4.2 端到端实证（`scripts/mt-smoke.mjs` 扩展，真实服务器 + 真 MCP 调用）：alice 的 runs 非空且只含投影字段、bob 的 runs 不含 alice 条目、admin 域同一 run 仍带 runtimeTokenId/tenantId/policy 原文（投影对照实证）。**SMOKE PASS**。
- [x] 4.3 部署与线上实证：scs001 快照 d4a4255 → relay → GitOps c9f258f → ArgoCD → rollout 成功；in-pod bundle 含「Recent runs」标记；线上 `/api/tenant/runs` 匿名 401。
- [x] 4.4 用户浏览器一眼验收（真账号 `aloadtree@gmail.com`，2026-10-11）：面板试跑 `appledb.get_device` / `appledb.search_devices` 与一枚 PAT 经 `/mcp` 的 `execute_action` 共 3 条真实调用，展开卡片可见时间/耗时/成败/actionId/连接名/失败 errorCode 与可展开 inputSummary；PAT 那条 `patName` 正确显示 `acceptance-pat`。
- [x] 4.5 验收抓到的缺陷并修复：面板自身发起的调用（`caller: web`）压根没用令牌，却被打上「外部令牌」占位——把唯一该显示占位的场景（无法指名的令牌：OBO 服务令牌/已撤销 PAT）淹没了。抽出纯函数 `runTokenLabel(run, t)`（`caller === "web"` 且无名时留空），并加真值表测试。
- [x] 4.6 验收边界记录：`/api/tenant/*` 只认 OIDC 会话，PAT bearer 走该族路由恒 401（PAT 归运行时面 `/mcp`、`/v1/*`）——既定边界，非缺陷。因此 PAT 调用仍会入本租户运行记录（落库 `tenant_id`），只是不能反过来读面板路由。
- [x] 4.7 修复轮上线复验（真 sha `5f8353a` → 快照 `b20f029`，pod `6f9d7b8cdb-h67pm`）：展开运行卡，PAT 那条显示 `· acceptance-pat`，面板自发起的两条不再出现「外部令牌」；失败行 errorCode 与输入摘要照常。
- 注：`list_apps` / `tools/list` 这类只读工具调用**不写**运行日志（不经 action-runner），只有 `execute_action` / 面板试跑才落库——验收造数据须用后者。
