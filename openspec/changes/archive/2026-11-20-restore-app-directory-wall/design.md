# Design

## 上下文：这块是怎么丢的

```
9359fee0 (2026-11-08 早)
   ├── d18813c3  09:09  加目录墙：connector-catalog.tsx（新文件）+ user-page.tsx 挂载 +50 行
   │                    …这条线到此为止，没有后续提交
   └── da58a1d8  04:24  范围令牌铸造：**从 9359fee0 切**，user-page.tsx 也改了（PAT 范围摘要）
                        …同一天晚些时候进 main
```
`git merge-base --is-ancestor d18813c3 da58a1d8` → 否；反向同样为否。两条平行线合并时，`user-page.tsx`
的冲突以 `da58a1d8` 那版为准，目录墙的挂载（含 `requestedService` 下发与 `formRef` 滚动）整段消失；
`connector-catalog.tsx` 是**新文件**，没有冲突，完整落地。于是「组件在、测试在、入口不在」。

`b22839cd`（11-14，「web 面构建不出来」）试图补 `ProviderOption` 的导出与类型收窄——它修的是
`ui.tsx` import 一个未导出类型这件事（TS2459）。该提交**同样不在 HEAD 祖先里**，所以这条类型
断链今天仍在。

## D1 挂载点放哪、为什么

`UserPanelBody` 的既有顺序是：PAT 卡 → 连接卡 → 试跑卡 → 运行记录卡。目录墙放在**连接卡之前**：

```
/me
 ├ PatsCard                        （跨平台唯一输出，固定置顶）
 ├ CatalogCard          ← 新增（浏览面：先看有什么）
 ├ ConnectionsCard                 （填写面：选定之后连）
 ├ TestRunCard
 └ RunsCard
```
理由：`CatalogCard` 的点击结果就是「让 `ConnectionsCard` 的表单就位」，从上面点、往下面滚是单向的；
反过来（表单在上、墙在下）点完要往回滚，读起来像两个不相干的块。

**替代方案与为何不取**：把目录折进 `ConnectionsCard` 内部作为一节。否决原因是表单已经很长
（provider 选择器 / authType / 连接名 / 密钥 / 虚拟连接分组），再塞 1570 条目的网格会把「保存」
推出一屏以上；且 `CatalogCard` 已是独立组件并带自己的测试，折进去等于重写。

## D2 深链 `/me?add=<service>` 的两个入口合一

目录卡片与深链是同一条通路，不是两条：

```js
// user-page.tsx（fork 新文件）
const [requestedService, setRequestedService] = useState(null);
// ① 卡片：onConnect={(service) => setRequestedService(service)}
// ② 深链：useEffect 读 useSearchParams().get("add") → setRequestedService(...)
// 二者都汇到 ConnectionsCard 的同一个 effect：
//   命中 pickable → 预填 service/authType + scrollIntoView + 聚焦首个输入 → onServiceApplied()
```
- 命中判定复用 `configurableProviders()`（与选择器同一份过滤）：`?add=` 指向仅 no_auth 的 provider
  时**查不到**，于是不预填——正是规格要求的「不改变页面」。
- 深链只预填，不提交：`ConnectionsCard.create()` 仍由用户点击触发。这是权限边界，不是交互偏好。
- 未知 service 不报错：`pickable.find()` 未命中即跳过，且**仍然**调 `onServiceApplied()` 清空
  一次性状态（否则同一深链返回后再进不会重新触发）。

**`#catalog` 与 `?add=` 的互不干扰**：锚点是 `<section id="catalog">`（`connector-catalog.tsx:113`），
与查询串无关，浏览器原生滚动即可，无需 JS。二者可同时存在（`/me?add=github#catalog`），互不消耗。

## D3 类型断链的修法

`web/src/user/user-page.tsx`（fork 新文件）：

```ts
export type ProviderOption = {
  service: string;
  displayName: string;
  authTypes: string[];
  /** 目录分类；连接表单的投影不带它，卡片墙需要。 */
  categories?: string[];
};
```
`ui.tsx`（**上游文件，不改**）已经在 `:402-405` 产出 `iconUrl/homepageUrl/categories` 并断言类型为
`ProviderOption[]`——它只需要这个类型被导出。`connector-catalog.tsx:191` 读 `provider.categories`，
也只需要该字段在类型里。故本项**零上游改动**。

> 判定依据不是 `tsc` 输出（`web/node_modules` 只有 2 个条目，装不起来），而是语言规则：跨模块
> `import type` 一个未 `export` 的类型是编译错误。tasks 第一条就是装上依赖后先跑到红、再修到绿。

## D4 文案改什么、不改什么

改 `web/src/locales/{zh-CN,zh-TW,en,ja,ru,fr}.json` 里的两个键（**上游既有文件，只改值**）：
- `userPanel.stepMint`
- `userPanel.patHint`

两者今天都写「铸造令牌 → 粘贴到壹座」。消费方（壹座 `ConnectorConnectPanel`）主路径是零粘贴
cross-mint，手动粘贴是回退。改后两处都先讲免粘贴、再讲回退，与真实通路一致。

**不改**：`stepSignIn` / `stepConnect`（仍然准确）、`learnMore`（文案与官网同源，与本次无关）、
任何 provider/action 文案（目录归上游，本仓不改不译）。

## D5 哪些文件被触碰

| 文件 | 归属 | 动作 |
|---|---|---|
| `web/src/user/user-page.tsx` | fork 新文件（`e7ec896f` 引入） | 挂载 `CatalogCard`、`ProviderOption` 导出 + `categories`、`requestedService` 通路、`?add=` 解析 |
| `web/src/user/connector-catalog.tsx` | fork 新文件（`d18813c3`） | 不改（已被 `d18813c3` 的落盘内容覆盖目录墙全部行为） |
| `web/src/user/connector-catalog.test.tsx` | fork 新文件 | 追加挂载断言（现只测纯函数与 `CatalogCard` 本体，不测挂载） |
| `web/src/locales/*.json` ×6 | 上游既有文件 | 仅改 `userPanel.stepMint` / `userPanel.patHint` 两个值 |
| `web/src/ui.tsx` | 上游既有文件 | **不改** |

无 schema 变更，无迁移。

## 风险

- **`?add=` 会不会被当成一次授权？** 不会：它只写 React 的预填状态，连接仍走 `POST /api/tenant/connections`
  的用户提交。规格里把这条写成场景，测试也要钉它。
- **目录墙渲染成本**：1570 个 provider，卡片墙默认只渲染 60 张（`catalogPageSize`）再展开。
  这是 `d18813c3` 既有行为，本次不改。
- **`TENANCY=off`**：`CatalogCard` 只在 `UserPage` 里挂载，而 `UserPage` 只在 `userMode` 下渲染，
  off 档看不到它。规格在两条相关需求里都保留了「off 档不变」场景。
