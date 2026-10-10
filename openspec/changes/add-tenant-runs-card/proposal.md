# add-tenant-runs-card

## Why

`/me` 用户面板有连接管理、PAT、试跑，但 agent 平台侧经 PAT 发起的真实调用（含 OBO 代调）在租户侧**完全不可见**——调用失败时租户没有任何排障入口，只能找平台管理员去 admin 运行记录页代查。数据层早已就绪：runs 落库带 `tenant_id`（`sqlite/runtime-store.ts:624`），store 读取接口 `RunLogListInput` 已含 `tenantId` 过滤（`runtime-store.ts:33-42`），只缺一个租户侧只读路由和一张卡。

（与 add-user-panel-return-and-picker 同源于 2026-10-11 用户反馈；grill 14 问定案中本 change 承接「租户自己的运行记录」切片。）

## What Changes

（2026-10-11 grill 定案）

- **新只读路由 `GET /api/tenant/runs?limit=20`**：走既有 `runWithTenant` 租户限定；范围 = 该租户名下一切调用（自有 PAT 直调 + service PAT 的 OBO 代调——runs 落库时同为该 tenant_id）；不做分页（工具页不是日志浏览器，全量/翻页是管理台的事）。
- **服务端投影**：仅回 `startedAt / durationMs / ok / actionId / caller / connectionProfile?.displayName ?? connectionId / errorCode / errorMessage / inputSummary / outputSummary / runtimeTokenId→patName 映射所需的 token id`；**剔除** `tenantId`、`policy` 明细（runtimeTokenId 仅用于服务端 PAT 名映射后即弃，不回传内部 id——修订：直接回传映射后的 `patName`，runtimeTokenId 不出路由边界）。
- **`/me` 运行记录卡**：默认收起、标题带计数（同免鉴权折叠组样式）、手动刷新（跟随现有刷新按钮，不轮询）、置于试跑卡之后置底；行内展示时间+耗时、成败、actionId、caller、连接名、PAT 名（client 端不需要 join——服务端已映射）、失败态 errorCode/errorMessage；inputSummary/outputSummary（服务端已脱敏，`run-log-summary.ts` 敏感 key/Bearer/JWT/带凭据 URL → `[redacted]`）点击展开。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `tenant-console`：新增「用户面板运行记录」requirement——租户侧只读运行记录路由（租户限定、投影、PAT 名映射）与 `/me` 运行记录卡（默认收起、手动刷新、置底）。

## Non-goals

- 不做分页/无限滚动（limit=20 最近优先；要看全量是管理台的事）。
- 不做租户侧供应商整页浏览与迷你控制台（同 change A 的 Non-goals 定位：/me 靠卡片生长不靠导航生长；重开触发条件见彼处）。
- 不动 admin 运行记录页（`runs-page.tsx`）任何行为。
- 不动 runs 落库/脱敏/保留策略（`run-log-summary.ts`、retention 既有机制原样）。
- 不新建浏览器端 E2E 设施——验收走 vitest 静态渲染断言 + 服务端单测。

## 上游文件触碰（upstream-touched）

| 文件 | 性质 | 必要性 |
| --- | --- | --- |
| `web/src/style.css` | 上游文件，fork 已追加段落 | 运行记录卡样式为纯追加 |
| `web/src/locales/*.json` | 上游文件，fork 已追加键 | 卡片文案新键为纯追加（六语言全配） |

fork 专有文件承载逻辑：`src/server/tenancy/tenant-routes.ts`（新路由）、`src/server/tenancy/`（PAT 名映射 helper 若独立）、`web/src/user/user-page.tsx`（卡片）、`web/src/user/tenant-api.ts`（客户端调用）。store 层 `RunLogListInput.tenantId` 已存在，**零上游 store 触碰**。

## Impact

- 服务端：一个只读路由 + 投影；无 DB / 迁移变化（tenant_id 与读取过滤已在）。
- 前端：一张新卡；不影响既有卡片。
- 验收门：服务端路由单测（租户隔离——A 租户看不到 B 租户 runs、投影字段集断言、OBO runs 含于本租户、PAT 名映射与未映射回退）+ vitest 静态渲染断言（默认收起带计数、手动刷新、置底、脱敏字段展示）+ i18n 完整性 + 用户浏览器一眼验收。
- 部署：与 change A 无耦合，随后上线。
