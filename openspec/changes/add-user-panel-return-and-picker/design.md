# add-user-panel-return-and-picker — Design

## Context

见 proposal「Why」。当前事实锚点（HEAD `9c6b6c4`）：

- admin 解锁 token 是纯内存 ref（`web/src/ui.tsx:214`），刷新即丢；但首次解锁由服务端种下 30 天 HMAC cookie `oomol_connect_admin_session`（`src/server/api/auth.ts:12,191-197`），`GET /api/auth/session` 是 public 路由（`auth.ts:206`），无 bearer 头时凭 cookie 判定（`auth.ts:269-272`）。前端 fetch 默认 `credentials: "same-origin"`（`web/src/api.ts:33`）。
- caveat：未配置 admin token 的部署 `authenticated` 恒为 true（`auth.ts:216-218`）——判定必须带 `adminAuthConfigured` 前置。
- `/api/tenant/session` 不能当 admin 探针（public path 上不解析 principal，admin token 持有者得 401）。
- `web/package.json` 无 cmdk、无 `@radix-ui/react-popover`；`web/src/components/ui/` 有 dialog.tsx / input.tsx / select.tsx 等，无 popover/command。
- provider 目录经 `/v1/providers` 已全量在客户端（`ui.tsx:349` 起，UserPanelShell 自取并传给 UserPage）；条目含 `service/displayName/authTypes`（另有 iconUrl/categories/scenario，本设计不使用）。
- 手动 no_auth 创建不落库（`connection-service.ts:373-380`），与虚拟行同一合成投影（`connection-service.ts:221-248`）。

## Goals / Non-Goals

**Goals**：可证 admin 的回程链接（两种到达场景都覆盖：管理台 SPA 内点入、admin 直落 /me）；provider 搜索选择器零新依赖；表单语义净化（无 no_auth 路径）。

**Non-Goals**（设计层）：不做键盘导航增强（cmdk 级体验）——Dialog 内 Tab/Enter 原生可达即可；不做服务端搜索（`/v1/providers?q=` 存在但列表已在客户端，无网络 churn 必要）；不动深链来源追踪。

## Decisions

### D1 admin 探测与回程链接

UserPanelShell 挂载时 `fetch("/api/auth/session")`（同源带 cookie），`adminAuthConfigured === true && authenticated === true` 才渲染「返回管理台」。链接用 react-router `<Link to="/overview">`——SPA 内导航，管理台壳层因 admin cookie 仍处解锁态（`loadRuntimeData` 凭 cookie 复认）。探测失败（网络错/404）一律视为非 admin，静默不渲染；不重试、不阻塞面板首渲（探测与 `/v1/providers` 并行）。

备选否决：把 admin 态从 App 组件下传——只覆盖 SPA 内点入场景，直落 /me（刷新/新标签）拿不到；把链接塞回侧边栏——租户可见性失控，重蹈死链覆辙。

### D2 零依赖搜索选择器（Dialog 方案）

provider 字段从 Radix Select 换成「按钮（显示已选 displayName）+ Dialog 弹层」。弹层 = 现有 Dialog + Input：顶部搜索框受控过滤 `providers`（displayName/service id 不区分大小写子串匹配），列表**只渲染前 N=50 条**匹配（1568 项全渲会卡；截断行数旁提示「共 X 条匹配」）；行内 displayName + service id + OAuth 徽章（`authTypes` 含 `oauth2` 时），点击选中回填并关弹层。列表过滤条件：`authTypes ∩ {api_key, oauth2} ≠ ∅`（排除仅 no_auth provider，一次过滤在数据源完成而非渲染时）。

选中联动：现有 `supportsOAuth` 逻辑照旧驱动 authType 选项（OAuth 项仅 provider 支持时出现）；authType 默认值仍 `api_key`，**移除 no_auth SelectItem**。

备选否决：新增 cmdk+popover 两个依赖——为「选中即走」的表单控件引入依赖，delta 薄原则不划算；Radix Select 自带 typeahead 仅首字母匹配，1568 项下不可用。

### D3 authType 表单净化

`user-page.tsx` ConnectionsCard：`create()` 的 `authType === "no_auth"` 分支随选项移除一并删除（`no_auth` 不再是可达状态）；`values` 仅 api_key 路径传 `{apiKey}`。服务端 `tenant-routes.ts` 的 no_auth 分支不动（API 面向后兼容，纯前端收口）。

### D4 文案与 i18n

新增键：`userPanel.backToAdmin`（返回管理台）、`tenant.connections.pickProvider`（选择提供商）、`tenant.connections.searchPlaceholder`、`tenant.connections.matchCount`（共 {n} 条匹配）、`tenant.connections.oauthCapable`（OAuth）。六语言全配（zh-CN/zh-TW/en/ja/ru/es 按现有 locale 文件集），走既有 i18n 键完整性测试。

## Risks / Trade-offs

- **admin 探测的多余请求**：每次 /me 挂载多一次轻量 GET（public、无凭据回传），可接受；不缓存判定结果（cookie 可能中途过期，宁可少显示链接不可错显示）。
- **前 50 条截断**：极泛搜索词（单字母）下用户看不到第 51 条——提示文案交代总数，属工具页可接受折衷；不引入虚拟滚动。
- **Dialog 可及性**：现有 Dialog 组件的 focus trap/ESC 沿用，不额外加工。
