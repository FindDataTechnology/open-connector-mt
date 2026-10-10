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
- [ ] 4.3 用户浏览器一眼验收（人工，需真账号）：/me 运行记录卡展开可见真实调用（时间/耗时/成败/actionId/PAT 名），失败调用 errorCode 可见。
