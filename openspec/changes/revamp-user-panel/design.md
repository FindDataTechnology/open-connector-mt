# Design — revamp-user-panel

## Context

见 proposal.md（Why）：`/me` 用户面板壳层借用管理台 `.app-shell` 两列网格致版式破碎；品牌错用上游「本地运行时控制台」；PAT 卡被虚拟连接淹没。全部为 `TENANCY=oidc` 用户面板内的纯前端改动，无 API/DB 变化。仓库硬约束：`TENANCY=off` 逐字节不变；fork delta 薄（上游文件只做追加式改动）。

事实基础（已核实）：

- `ConnectionSummary` 已有 `virtual: boolean`；`disconnect()` 对 no_auth provider 会 `connectWithoutAuth` 重建虚拟行（删除无效，故虚拟行不渲染删除是正确语义而非规避）。
- 目录 1568 个 app 中约 24 个涉及 no_auth，虚拟组是小集合，无分页压力。
- 用户面板壳层与页面组件均为 fork 专有代码路径（`web/src/ui.tsx` 的 `UserPanelShell`、`web/src/user/user-page.tsx`），仅 locale 与 style 为上游文件追加。

## Goals / Non-Goals

**Goals**：恢复用户面板正常版式；PAT 成为第一视觉焦点；虚拟连接降噪；品牌正名为萬星连接器。
**Non-Goals**（design 级边界，proposal Non-goals 之外）：

- 不改 `UserPage` 的数据获取与错误处理结构（`tenant-api` 不动，除渲染所需无新端点）。
- 不动管理台任何代码路径（`AppShell`、`UnlockView` 等）。

## Decisions

### D1 壳层：新容器类，而非网格跨列

`UserPanelShell` 根节点从 `className="app-shell"` 换为 `className="user-shell"`，`web/src/style.css` 追加：

```css
.user-shell {
  display: flex;
  flex-direction: column;
  min-height: 100svh;
}
```

- 备选：`console-header`/`user-shell-main` 加 `grid-column: 1 / -1` 跨列——仍寄生在管理台网格上，管理台将来改列宽会再次砸到用户面板，否决。
- 头部横向留白沿用 `.user-shell-main` 的 `max-width: 880px; margin: 0 auto` 语义，`console-header` 包一层同宽容器（新增 `.user-shell-header-inner`），保证品牌条与主区左对齐。

文件：`web/src/ui.tsx`（fork 已改区）+ `web/src/style.css`（**上游文件，纯追加**）。

### D2 品牌：用户面板专属键，不动 `brand.subtitle`

新增 locale 命名空间 `userPanel.brand`（zh-CN「萬星连接器」，en「Wanxing Connector」，ja/ru/等六语言按 en 语义翻译），顶栏与未登录卡引用它；管理台继续用 `brand.*`。不引入 env 品牌覆盖（grill Q1 定案 a：fork 本身就是萬星谱系官方载体，配置面是过度设计）。

文件：`web/src/locales/*.json`（**上游文件，追加键**，六语言全配——既有 i18n 完整性测试会强制）。

### D3 顶栏：删「概览」链接

`UserPanelShell` 头部移除 `console-admin-link`（`/overview` 在 admin token 后，普通租户死链）；主题切换保留。「仅管理员可见」需用户面板感知 admin 身份，而 OIDC 会话与管理 token 两套认证不互通，做不干净，否决。

文件：`web/src/ui.tsx`（fork 已改区）。

### D4 未登录卡：复用 `Centered` + 新文案键

未登录分支改为品牌（`userPanel.brand`）+ `userPanel.signInIntro`（一句功能说明）+ 既有登录按钮，包一层 `.user-hero-card`（居中卡片样式，style.css 追加）。不新建路由/组件文件。

### D5 连接分组：按 `virtual` 过滤成两组

`user-page.tsx` 的 `ConnectionsCard` 拆两段渲染：

- 自建组 = `connections.filter(c => !c.virtual)`，现状行为（状态点、徽章、删除）不变；
- 虚拟组 = `connections.filter(c => c.virtual)`，`<details>` 式默认收起区块，标题 `userPanel.noAuthGroup`（「免鉴权数据源（无需配置，直接可用）」）+ 计数徽章；条目行不渲染删除按钮，其余（徽章）保持。

`<details>`/受控折叠二选一放实现期，无行为差异（spec 只约束默认收起与计数）。试跑卡的连接名下拉取并集（自建+虚拟都可试跑——spec 场景「虚拟行可正常用于试跑」）。

文件：`web/src/user/user-page.tsx`（fork 专有）+ locales。

### D6 PAT 卡置顶：渲染顺序调整 + 指引文案

`UserPage` 主区渲染顺序改为 `PatsCard → ConnectionsCard → TestRunCard`；`PatsCard` 顶部加一行说明 `userPanel.patHint`（「把令牌粘贴到 agent 平台（如壹座）的连接器设置中」）。纯 JSX 顺序调整，无状态/逻辑变更。

### D7 测试：vitest 静态渲染断言

沿用 `user-page.test.tsx` / `tenant-routing.test.ts` 的 `renderToStaticMarkup` 风格，新增断言：

- 未登录：markup 含 `userPanel.signInIntro` 文案与登录按钮，不含 `/overview` 链接；
- 已登录：PAT 卡节点先于连接卡节点出现（断言 markup 中的索引顺序）；虚拟组默认收起（`details` 无 `open` 属性）且虚拟行无删除按钮；
- 品牌：`UserPanelShell` 渲染含 `userPanel.brand` 键译文、不含「本地运行时控制台」；
- i18n 完整性由既有 locale 测试兜底（六语言键齐）。

不建 Playwright（grill Q6 定案）。

## Risks / Trade-offs

- [locale 六语言翻译质量参差] → 品牌词「Wanxing Connector」各语言可保留拉丁转写；说明句以 en 语义为准，缺失键回退 en（既有机制）。
- [`<details>` 原生折叠在暗色主题下的样式表现] → 折叠区块复用 `.user-card` 边框体系，实现期目检；不引组件库新依赖。
- [删除「概览」后管理员失去从 /me 跳管理台的便利] → 管理员本就经直连 URL/书签进管理台（95420eb 定案的行为），非回归。

## Migration Plan

前端-only：构建 console 镜像 → 滚动替换线上容器 → 回滚 = 回滚镜像 tag。无数据迁移、无 env 变化。部署先行于 paas `add-connector-console-link`（闭环验收顺序，无硬依赖）。

## Open Questions

（无）
