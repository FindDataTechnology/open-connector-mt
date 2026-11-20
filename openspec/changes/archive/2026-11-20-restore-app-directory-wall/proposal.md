# Proposal

## Why

`/me` 用户面板的**应用目录卡片墙**（`add-app-directory` 交付的「浏览式连接」入口）从未进入 `main`：它与 `da58a1d8`
（范围令牌铸造）是同日从 `9359fee0` 分出的两条互不为祖先的线，合并时只带进了
`web/src/user/connector-catalog.tsx` 组件与其 129 行测试，`user-page.tsx` 的挂载改动（50 行）被同文件
的另一条线覆盖掉了。后果是两条，今天都在产线上：

1. **壹座侧的死链**：壹座 `ConnectorBindingsView` 的「浏览可连接的目录」指向
   `${meUrl}#catalog`，而 `id="catalog"` 的产出者 `CatalogCard` 在 HEAD 上零挂载点 ⇒ 新标签落在
   `/me` 顶部，什么也没发生，且不报错。
2. **面板仍只能"先知道名字才能连"**：`add-app-directory` 要消灭的正是这件事。

3. **HEAD 上 `web` 面有一段类型断链**：`web/src/ui.tsx:48` 写着
   `import type { ProviderOption } from "./user/user-page"`，而 `user-page.tsx:25` 是
   `type ProviderOption = {…}` ——**未导出**。跨模块 import 一个未导出的类型是编译错误
   （TS2459）。`b22839cd`（「origin/main 的 web 面构建不出来——补导出与类型收窄」）修过这一处
   （导出 + 补 `categories`），但该提交**不在 HEAD 的祖先里**（与 `da58a1d8` 同属那条未合入的线）。
   本次未跑 `tsc` 验证（`web/node_modules` 只有 2 个条目，装不起来），此条按语言规则判定；
   tasks 里第一条就是装上依赖后先红后绿地证它。

同时该面板的三步行引导（未登录欢迎卡与 PAT 卡提示）仍写着「铸造访问令牌，**粘贴**到壹座」，
而壹座主路径已是零粘贴跨站铸造（`cross-mint`）——第一次用的客户会照着过时的那条走。

## What Changes

- **恢复挂载**：`UserPanelBody` 恢复 `<CatalogCard>`（捡回 `d18813c3` 的挂载与 `requestedService`
  下发通路），`ConnectionsCard` 收到目标 service 时预填表单并把表单滚入视口、聚焦首个输入。
- **补回类型导出**：`ProviderOption` 导出并把目录墙需要的 `categories` 纳入类型（`b22839cd` 的
  做法），否则 `ui.tsx` / `connector-catalog.tsx` 的 import 不成立。
- **新增深链**：`/me?add=<service>` 命中目录内某个可配置 provider 时，等同于点击该卡片
  （预填 + 滚动 + 聚焦）；未知 service 或仅 no_auth 的 provider 不改变页面，也不报错。
- **`#catalog` 真正可达**：锚点随挂载恢复而存在；顺带保证 `/me` 的两个入口（`#catalog` 哈希与
  `?add=` 查询）互不吞掉对方的其它查询参数。
- **纠正过时文案**：`userPanel.stepMint` / `userPanel.patHint`（六语）改为陈述**两条都成立**的
  真实路径——零粘贴跨站铸造（首选）与手动铸造-粘贴（回退），不再把粘贴写成唯一路径。
- 不为目录墙新增任何服务端接口、迁移或 provider 目录字段。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `tenant-console`: 「用户面板连接生命周期」补一条——面板 SHALL 提供可浏览的应用目录（每
  provider 一张卡，点击复用既有连接表单），并 SHALL 接受 `/me?add=<service>` 深链把该卡片的选择
  落到表单上；未知/不可配置的 service 不改变页面。未登录欢迎卡与 PAT 提示的三步/回退表述 SHALL
  与「零粘贴跨站铸造为主、手动粘贴为回退」一致。

## Impact

- 触碰的**上游文件**（仅一处，不可避免）：`web/src/ui.tsx` —— `UserPanelShell` 已经渲染
  `UserPage`，本次**不改它**；`ProviderOption` 的类型收窄与 `iconUrl/homepageUrl/categories`
  的保留在 `d18813c3` 中已随组件一起落地（见 tasks 3.1 的实测），故无上游改动。
- fork 新文件：`web/src/user/user-page.tsx`（挂载 + 深链 + 表单联动）、
  `web/src/user/connector-catalog.tsx`（已存在，仅在被挂载后首次产出 `id="catalog"`）。
- fork 内的上游既有文件：`web/src/locales/*.json` 的 `userPanel.stepMint` / `userPanel.patHint`
  两个键（六语）。
- 不影响：`TENANCY=off` 的管理台（该面板只在 `TENANCY=oidc` 挂载）、任何服务端路由、PAT 铸造与
  销毁语义、目录内容。

## Non-goals

- 不把连接器整站嵌进壹座 iframe。壹座 `/external/:appId` 代理只转发 `content-type` 与
  `authorization`、**不转发 cookie**，而 `/me` 靠连接器自己的 OIDC cookie 认人 ⇒ 嵌进来的会是
  一个永远未登录的面板。放通 cookie 更糟：等于把壹座的 forward-auth 会话交给另一个域。嵌入整站的
  正当形态是「新标签打开连接器 origin」，不是同源代理。
- 不改目录墙的排序、分页、分类 facet 与卡片视觉；不新增目录字段或服务端接口。
- 不解决「壹座里按 provider 看已连 SaaS」与「萬星看 agent 外部系统需求」——那两件分别属于
  `paas/connector-inventory-in-connections` 与 `fd-wanxing/surface-connector-requirements-in-wanxing`。
