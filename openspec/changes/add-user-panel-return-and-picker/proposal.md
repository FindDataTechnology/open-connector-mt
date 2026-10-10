# add-user-panel-return-and-picker

## Why

revamp-user-panel 把 `/me` 修成了独立壳层，但留下两个走不通的点（用户 2026-10-11 实测反馈）：

1. **导航单程陷阱**：管理台侧边栏在 `TENANCY=oidc` 下含「我的连接」入口，admin 点击后整个 AppShell 被替换为 UserPanelShell（`ui.tsx:305`），侧边栏消失且应用内无任何回程——只能改 URL 或依赖浏览器返回。revamp 定案「顶栏死链移除」堵住了租户撞解锁墙的旧病，但把 admin 的回程也一起堵死了。
2. **新增连接不可用**：表单 provider 选择是平铺 Select 装全目录（约 1568 项），无搜索；且 authType 含 `no_auth` 选项——而手动 no_auth 创建根本不落库（`connection-service.ts:373-380` `connectWithoutAuth` 只返回与自动虚拟行相同的合成投影），是纯粹的困惑源。可搜索下拉在 revamp 的 Non-goals 中明示留给后续提案，本 change 即该提案。

## What Changes

（以下为 2026-10-11 grill 定案，14 问全数落定）

- **可证 admin 的回程链接**：UserPanelShell 挂载时探测 `GET /api/auth/session`（public 路由；admin 首次解锁种下的 30 天 HMAC cookie `oomol_connect_admin_session` 凭 cookie 即报 `authenticated: true`），当且仅当 `adminAuthConfigured && authenticated` 时顶栏渲染「返回管理台」→ SPA 内导航 `/overview`（admin cookie 在，无需重新解锁）。普通租户永远看不到该链接。
- **零依赖 provider 选择器**：表单 provider 字段改为「选择提供商」按钮 + 现有 Dialog 组件弹出的搜索选择器——顶部搜索框、客户端过滤（全量目录已在客户端）、只渲染前 N 条匹配；行内 displayName + service id + OAuth 能力标记（选中后联动 authType 可选项）。**不新增任何依赖**（仓库无 cmdk/@radix-ui/react-popover，也不为该控件引入）。
- **选择器列表排除仅 no_auth 的 provider**（`authTypes ∩ {api_key, oauth2} = ∅`）：它们由免鉴权折叠组天然承载，「搜索要配凭据的 provider」的语义里不该出现。
- **表单 authType 删除 no_auth 选项**：只留 API Key / OAuth。
- 明确不做：popular 置顶（无数据支撑，硬编码是拍脑袋）、categories/scenario 展示（噪音大于价值）、深链租户返回提示（PAT 卡文案已点名「粘贴到 agent 平台」）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `tenant-console`：「用户面板独立壳层」requirement 的顶栏行为改写——从「顶栏无管理入口」改为「可证 admin 会话显示回程、租户永不见」；「用户面板连接生命周期」requirement 的新增表单行为改写——provider 走搜索选择器（排除仅 no_auth provider）、authType 仅 API Key/OAuth。

## Non-goals

- 不做迷你控制台、不做供应商整页浏览——/me 保持工具页定位，靠卡片生长不靠导航生长。重开辩论的触发条件：/me 停留数据异常，或用户反馈集中在「想逛供应商目录」。
- 不改免鉴权虚拟连接的呈现（revamp 已定案：折叠组+计数+无删除）。
- 不动 `TENANCY=off`（上游管理台）任何行为。
- 不动后端 API 与数据库（本 change 纯前端；`/api/auth/session` 为既有上游端点，只读探测）。
- 不新建浏览器端 E2E 设施——验收走 vitest 静态渲染断言。
- 不做 PAT 卡、试跑卡的任何改动（change B `add-tenant-runs-card` 另行处理运行记录）。

## 上游文件触碰（upstream-touched）

| 文件 | 性质 | 必要性 |
| --- | --- | --- |
| `web/src/ui.tsx` | 上游文件，fork 已改（`UserPanelShell` 即在此） | admin 探测 + 回程链接 + 选择器挂载的最小落点，继续集中于此 |
| `web/src/style.css` | 上游文件，fork 已追加段落 | 选择器弹层样式为纯追加，不动上游规则 |
| `web/src/locales/*.json` | 上游文件，fork 已追加键 | 新文案键为纯追加（六语言全配） |

fork 专有文件（`web/src/user/user-page.tsx`、`web/src/user/tenant-api.ts`）承载表单与选择器逻辑。**不触碰** `src/**`（后端）、`src/providers/**`、迁移。

## Impact

- 纯 React console 前端改动；无 API / DB / 迁移变化；零新依赖。
- 仅影响 `TENANCY=oidc` 的 `/me` 用户面板；上游可合并性：改动集中在前述追加区域与 `UserPanelShell`/用户面板文件，fork delta 增量薄。
- 验收门（grill 定案）：vitest 组件测试（`renderToStaticMarkup` 断言——admin 探测为 true/false 两态的链接渲染、选择器弹层结构与前 N 条截断、仅 no_auth provider 不在列表、authType 选项不含 no_auth）+ 既有 i18n 键完整性测试 + 用户浏览器一眼验收。
- 部署：无耦合；与 change B 互不依赖，先行上线。
