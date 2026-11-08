# Tasks — add-app-directory

## 1. 数据面

- [x] 1.1 `web/src/ui.tsx`：`/v1/providers` 映射保留 `iconUrl` / `homepageUrl` / `categories`（兼容 `{id,displayName}` 与字符串）
- [x] 1.2 `web/src/user/user-page.tsx`：`ProviderOption` 带上这三个字段并导出

## 2. 目录面

- [x] 2.1 `web/src/user/connector-catalog.tsx`：`catalogEntries`（连接优先 + 名称/服务/分类匹配）、`catalogCategories`（按数量排序）、`CatalogCard`（搜索 + 分类 chip + 发丝网格 + 60 张分页 + 空态）
- [x] 2.2 卡片点击复用既有连接表单：`requestedService` → `setService` + `scrollIntoView` + 聚焦（不新增连接实现）
- [x] 2.3 `web/src/styles/user-catalog.css`：三列发丝网格（1px 间隙压在 border 上）/ 2 列 / 1 列，hover + focus-visible + active chip 状态，等宽数字用于计数
- [x] 2.4 `web/src/shared-ui.tsx`：`ProviderIcon` / `providerIconSource` 入参收窄为 `ProviderIconTarget`（完整 `ProviderDefinition` 仍满足）
- [x] 2.5 六语 `userCatalog.*`（en / zh-CN / zh-TW / ja / fr / ru）

## 3. 门禁

- [x] 3.1 `npx tsc -p web/tsconfig.json --noEmit` 净
- [x] 3.2 `npx oxlint` 0 warning 0 error；`oxfmt --check` 通过
- [x] 3.3 单测 8 条：连接优先排序、三路搜索匹配、多分类筛选、免认证标记、分类计数排序、无分类目录返回空、静态渲染卡片数与状态文案
- [x] 3.4 `npm run build --workspace web` 通过
- [x] 3.5 `impeccable detect --json` 对三个改动文件返回 `[]`
- [x] 3.6 视觉验收：桌面 1280（三列 379px×3，图标全部真实加载、已连接置顶绿勾、状态右对齐成列）与窄屏 430（单列 342px、chip 换行、无横向溢出）均已截图确认。**期间修掉两个真缺陷**：`@container` 断点因页面无 `container-type` 祖先而永不生效 → 改 `@media` 1080/720；卡片三行布局右侧留白过大 → 改 `图标|文案|状态` 单行（86px→64px）
- [ ] 3.7 `openspec validate add-app-directory --strict`
- [ ] 3.8 出片并上产（平台镜像 + 连接器镜像），在壹座侧确认入口可达
