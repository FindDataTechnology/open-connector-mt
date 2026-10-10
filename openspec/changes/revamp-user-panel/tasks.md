# Tasks — revamp-user-panel

## 1. 壳层修复与品牌（独立可验收：`/me` 版式恢复 + 品牌正名）

- [x] 1.1 `web/src/ui.tsx`（fork 已改区）：`UserPanelShell` 根节点 `app-shell` → `user-shell`；头部包同宽容器与主区左对齐；移除「概览」`console-admin-link`；品牌文本改引 `userPanel.brand`。验证：vitest `web/src/tenant-routing.test.tsx` 断言 markup 不含 `/overview` 链接、含新品牌键译文
- [x] 1.2 `web/src/style.css`（上游文件，纯追加）：`.user-shell`（纵向 flex + min-height）、`.user-shell-header-inner`、`.user-hero-card`。验证：目检 TENANCY=oidc 本地起服 `/me` 头部为顶部通栏、无窄列挤压；`TENANCY=off` 起服 diff 管理台 DOM/CSS 无变化
- [x] 1.3 `web/src/locales/*.json`（上游文件，追加键，六语言全配）：`userPanel.brand`（zh-CN「萬星连接器」/en「Wanxing Connector」）、`userPanel.signInIntro` 及后续组用键。验证：既有 i18n locale 完整性测试全绿

## 2. 未登录引导卡（独立可验收：未登录态截图对比）

- [x] 2.1 `web/src/user/user-page.tsx`（fork 专有）+ style：未登录分支改为 `.user-hero-card` 居中卡（品牌 + `signInIntro` + 既有登录按钮）。验证：vitest `user-page.test.tsx` 新增断言 markup 含 intro 文案与登录按钮

## 3. 连接分组与 PAT 置顶（独立可验收：已登录态列表结构）

- [x] 3.1 `web/src/user/user-page.tsx`：`ConnectionsCard` 按 `virtual` 拆两组——自建组置前保持现状行为；虚拟组默认收起（标题 `userPanel.noAuthGroup` + 计数徽章）、条目不渲染删除按钮；试跑卡连接名下拉取两组并集。验证：vitest 断言虚拟组默认无 open、虚拟行无删除、自建行有删除
- [x] 3.2 `web/src/user/user-page.tsx`：主区渲染顺序 `PatsCard → ConnectionsCard → TestRunCard`；`PatsCard` 顶部加 `userPanel.patHint` 指引行。验证：vitest 断言 PAT 卡节点在 markup 中先于连接卡出现、含指引文案

## 4. 回归与验收门

- [x] 4.1 全量本地门：`vitest` 全绿（含既有 `user-page` / `tenant-routing` / i18n 套件）+ typecheck。验证：CI 或本地命令输出
- [x] 4.2 `TENANCY=off` 回归：管理台代码路径零触碰（改动全部位于 fork 专有组件/追加样式/追加 locale 键），mt-smoke off 档重启断言全过（tenant face gone + admin token 仍管 admin 域）。验证：mt-smoke SMOKE PASS
- [ ] 4.3 真实 OIDC 模式浏览器走查（用户线上验收时一并：未登录卡 → 登录 → PAT 置顶 → 虚拟组展开/收起 → 试跑一条 no_auth action）。验证：用户确认

## 5. 部署

- [x] 5.1 构建镜像并滚动线上容器。验证：scs001 GHA 出片 sha-f5c7908（hkccr→cheap-3 tcr-relay 回灌 ccr 实证 digest sha256:fa2e9b66）、GitOps 5da0a5e、ArgoCD rollout 成功、线上 bundle index-7W6phDS_ 含 user-shell/萬星连接器/user-hero-card/user-noauth-group/patHint 五标记
- [ ] 5.2 用户浏览器验收：线上登录 `/me`，铸一个 PAT 并粘进壹座走通关键路径。验证：用户确认闭环
