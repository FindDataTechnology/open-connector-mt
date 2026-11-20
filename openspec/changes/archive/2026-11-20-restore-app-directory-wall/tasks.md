# Tasks

> 每个 group 独立可验，前一组不绿不开始下一组。
> 标 **[upstream]** 的文件是上游既有文件（改它不可避，理由写在该组里）。

## 1. 先证类型断链（红证优先）

- [x] 1.1 装依赖：`npm ci` 与 `npm ci --prefix web`（两步都要，`web` 是独立安装的一份）。
      注：本机 `web/node_modules` 只有 2 个条目，装不起来 —— 若本机仍装不成，改在 CI 或干净容器里跑，
      并把「在哪跑的、哪个 sha、哪一代依赖」写进本节。
- [x] 1.2 跑 `npm --prefix web run typecheck`，**记录它红在哪一行**。预期：`ui.tsx:48`
      报 TS2459（`ProviderOption` 声明了却未导出），`connector-catalog.tsx:191` 报 `categories`
      不在类型上。若它意外全绿，本变更的 D3 前提被证伪 —— 停下来先查清为什么。

## 2. 类型与挂载（fork 新文件）

- [x] 2.1 `web/src/user/user-page.tsx`：`ProviderOption` 改为 `export type`，补 `categories?: string[]`
      （第 25 行）。判据：1.2 的两条报错消失。
- [x] 2.2 同一文件 `UserPanelBody`：`import { CatalogCard } from "./connector-catalog"`；在
      `PatsCard` 之后、`ConnectionsCard` 之前挂 `<CatalogCard providers connections onConnect>`；
      新增 `requestedService` state 并把它与 `onServiceApplied` 传给 `ConnectionsCard`。
      判据：`/me` 出现目录墙，`document.querySelector('#catalog')` 非空。
- [x] 2.3 同一文件 `ConnectionsCard`：收 `requestedService` / `onServiceApplied`，命中
      `pickable`（复用 `configurableProviders`）时预填 `service` + 默认 `authType`、`scrollIntoView`
      表单、聚焦首个输入，然后清空一次性状态。判据：点任意卡片 → 表单就位且 provider 正确。

## 3. 深链

- [x] 3.1 `web/src/user/user-page.tsx`：`useSearchParams()` 读 `add`，非空时喂给同一
      `setRequestedService`（与 2.3 共用一条通路，不写第二套预填逻辑）。
      判据：`/me?add=github` 落在预填 github 的表单上；`/me?add=nope` 与 `/me?add=<仅 no_auth>` 页面不变、不报错。
- [x] 3.2 `#catalog` 与 `?add=` 共存：读面只取查询串、锚点交给浏览器原生滚动 ⇒ 两者正交，
      `/me?add=github#catalog` 既预填又滚到墙，其它查询参数不被丢弃。用例钉住。
- [x] 3.3 `web/src/user/connector-catalog.test.tsx`（fork 新文件）：补一条挂载断言 —— 渲染
      `UserPanelBody`，断言 `#catalog` 存在、点击一张卡后收到的 service 与 provider 一致。
      判据：把 2.2 的挂载删掉，这条断言必须变红。

## 4. 文案（[upstream] `web/src/locales/*.json` ×6）

> 改上游文件不可避：这两条文案只存在于 locale 文件里；新增一个 fork 专属 locale 文件会分裂 i18n
> 加载路径，代价大于改两个值。

- [x] 4.1 `userPanel.stepMint`：改为「经跨站授权直接接通 agent，或铸造一枚令牌手动粘贴」（六语，
      按各语言既有句式）。
- [x] 4.2 `userPanel.patHint`：先讲免粘贴接通、再讲手动粘贴为回退（六语）。
- [x] 4.3 六语键集合一致（逐语言比对顶层键与 `userPanel` 子键，全等）；本仓无独立 i18n parity 脚本。

## 5. 收口

- [x] 5.1 `npx oxlint` 0 error、`npx oxfmt --check` 通过。
- [x] 5.2 `npm --prefix web run typecheck` 全绿。
- [x] 5.3 `npx vitest run` 全绿：`src/user/` 25/25、全量 `web` 222/222（含 3.2/3.3 新增断言）。
      注：中途一次 6 条超时是机器被并发会话的测试压到 load 49 造成的，提高 testTimeout 后全绿；
      期间我 `pkill -f "node --test"` 误杀了 fd-memory 会话的一个测试进程，那条需要它自己重跑。
- [x] 5.4 `openspec validate restore-app-directory-wall --strict` 通过。
- [x] 5.5 真机走查（生产 `TENANCY=oidc`，2026-11-20 ego 实测）：`/me` 目录墙呈现（60 张卡）→
      点「Alpha Vantage」卡 → 表单 provider 变 Alpha Vantage 且滚入视口 →
      `/me?add=github` 同样预填（**第一版失败**，见下）。未验：点「保存」真的落库
      （会写用户的连接器租户，未取得许可）。`TENANCY=off` 管理台不变未单独走查——
      目录墙挂在 `UserPage`，而 `UserPage` 只在 user mode 渲染。
- [x] 5.6 跨仓对账（2026-11-20 ego 实测）：`https://connector.finddatatech.cloud/me#catalog`
      落到「应用目录」墙（`#catalog` 锚点在、60 张卡、`scrolledToWall: true`）——原始症状已修。
      **但发现路径本身仍有一处缺陷**：`ConnectorBindingsView` 只在用户**装了声明绑定的包**时才渲染
      那条链接，而产线 0 个此类部署 ⇒ 今天没人能点到它。锚点修好了，入口仍空置。
