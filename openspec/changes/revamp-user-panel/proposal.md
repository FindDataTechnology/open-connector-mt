# revamp-user-panel

## Why

`/me` 用户面板的壳层（`UserPanelShell`）复用了管理台的 `.app-shell` 两列网格类，但其 DOM 是「头部一行 + 主区一行」结构——头部被自动摆放塞进左侧 15.5rem 窄列，品牌条/主题切换散落错位，页面版式破碎（线上 `connector.finddatatech.cloud/me` 实证）。叠加三个信息架构问题，实际用户走不通「登录 → 铸 PAT → 粘贴进壹座」的关键路径：

1. 用户面板品牌沿用上游 `brand.subtitle` =「本地运行时控制台」——云服务自称本地控制台，是错误信息；
2. PAT 铸造卡（接入壹座的唯一必经操作）被 14+ 条虚拟免鉴权连接压到折叠线以下；
3. 顶栏「概览」链接指向 admin token 后的管理台，普通租户点击撞解锁墙；虚拟连接行的「删除」按钮是无效操作（`disconnect()` 对 no_auth provider 当场重建虚拟行）。

## What Changes

（以下为 2026-10-10 grill 定案）

- **壳层修复**：为用户面板引入独立容器类（`.user-shell`，纵向 flex），不再借用管理台 `.app-shell` 网格；恢复「顶部通栏品牌条 + 主区」的正常版式。
- **品牌正名**：用户面板品牌键独立于管理台——「萬星连接器 / Wanxing Connector」（fork 追加六语言 locale 键）；管理台保持上游原文不动。
- **顶栏死链移除**：删除用户面板顶栏的「概览」管理入口（管理员经直连 URL 进管理台，「登录后落 `/me`」规则不变），保留主题切换。
- **未登录引导卡**：居中卡片 = 品牌 + 一句说明（托管 SaaS 连接、铸造 PAT 授权 agent 平台）+ 登录按钮。
- **连接分组**：用户自建连接为一组置前；虚拟免鉴权连接（`ConnectionSummary.virtual === true`）独立分组「免鉴权数据源（无需配置，直接可用）」，**默认收起**、标题带计数，置于用户连接组之后；虚拟行**不渲染删除按钮**。
- **PAT 卡固定置顶**：置于连接列表之前，不随状态漂移；卡内说明文案点名「把令牌粘贴到 agent 平台（如壹座）的连接器设置中」。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `tenant-console`：新增「用户面板独立壳层」（版式与品牌不依赖管理台布局、顶栏无管理入口）与「未登录引导页」requirement；「用户面板连接生命周期」增加虚拟连接分组呈现（默认收起、无删除）的行为；「PAT 管理入口」增加固定置顶与接入指引文案的行为。全部显式限定 `TENANCY=oidc`；`TENANCY=off` 逐字节不变。

## Non-goals

- 不动 `TENANCY=off`（上游管理台）的任何行为——布局修复仅作用于用户面板壳层。
- 不动 OBO / service-PAT 代调路线与壹座侧粘贴链路（既有能力，壹座侧深链另由 paas `add-connector-console-link` 承担）。
- 不做连接改名、目录搜索等增强；**新增连接表单的 provider 可搜索下拉（现装全目录 1568 项）明示留给后续提案**。
- 不新建浏览器端 E2E 设施（Playwright 等）——验收走 vitest 静态渲染断言（见 Impact）。
- 不动后端 API 与数据库（`virtual` 标志已在 `ConnectionSummary` 中，纯前端分组；虚拟行去删除为纯渲染决策）。

## 上游文件触碰（upstream-touched）

| 文件                     | 性质                                           | 必要性                                        |
| ------------------------ | ---------------------------------------------- | --------------------------------------------- |
| `web/src/ui.tsx`         | 上游文件，fork 已改（`UserPanelShell` 即在此） | 壳层结构与死链移除的最小落点，继续集中于此    |
| `web/src/style.css`      | 上游文件，fork 已追加段落                      | 新增 `.user-shell` 等类为纯追加，不动上游规则 |
| `web/src/locales/*.json` | 上游文件，fork 已追加键                        | 用户面板品牌与文案新键为纯追加（六语言全配）  |

fork 专有文件（`web/src/user/user-page.tsx`、`web/src/user/tenant-api.ts`）承载分组、置顶与引导卡。**不触碰** `src/providers/**`、后端路由、迁移。

## Impact

- 纯 React console 前端改动；无 API / DB / 迁移变化。
- 仅影响 `TENANCY=oidc` 的 `/me` 用户面板；上游可合并性：改动集中在前述追加区域，fork delta 增量薄。
- 验收门（grill 定案）：vitest 组件测试（`renderToStaticMarkup` 断言品牌键、虚拟分组结构与默认收起、虚拟行无删除按钮、PAT 卡置顶、顶栏无管理入口）+ 既有 i18n 键完整性测试 + 用户浏览器一眼验收；不新建 Playwright 设施。
- 部署顺序：本 change 先于 paas `add-connector-console-link` 上线（互无硬依赖，但闭环验收需要新版 `/me` 先就位）。
