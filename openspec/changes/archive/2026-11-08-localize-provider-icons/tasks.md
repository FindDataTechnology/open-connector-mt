# Tasks — localize-provider-icons

## 1. 实现

- [x] 1.1 `web/provider-icons-plugin.ts`：`localize`（默认开）、`localDir`、`concurrency`；构建期下载并改写映射为 `/provider-icons/<service>.<ext>`
- [x] 1.2 每次构建先 `rmSync` 清空目录；单个失败保留远程 URL 并按聚合条数告警，不抛错
- [x] 1.3 `configResolved` 取 vite `root` 与 `base`，路径按 base 拼接；`PROVIDER_ICONS_REMOTE=1` 跳过下载
- [x] 1.4 `.gitignore` 忽略 `web/public/provider-icons/`
- [x] 1.5 `web/src/locales/fr.json`：`userCatalog.matchCount` 改成不与英文同形的法语表述

## 2. 门禁

- [x] 2.1 单测 4/4：目录不可达降级为空映射；下载落地并改写成 `/provider-icons/…`；单点失败保远程并报 `1/2`；`localize:false` 完全不下载
- [x] 2.2 `npx tsc -p web/tsconfig.json --noEmit` 净；`oxlint` 0/0；`oxfmt` 通过
- [x] 2.3 web 全量单测 219/219（含 i18n 键与占位符一致性）
- [x] 2.4 `npm run build --workspace web` 产出 `dist/web/provider-icons/` 1716 个文件 / 22.8M

## 3. 上产与实证

- [x] 3.1 出片 `yizuo/open-connector-mt:sha-9dd6365`（digest `f7cf24a3`），滚到 fd-prod
- [x] 3.2 pod 内实证：`dist/web/provider-icons` 1716 个文件、22.8M；`index-*.js` 里 `/provider-icons/` 命中 1716 次、`static.oomol.com/logo` 命中 **0** 次
- [x] 3.3 覆盖率核对：我们 1570 个 provider 中 1565 个命中本地图标（99.7%）

## 4. 收尾

- [x] 4.1 修复重构时把 `load` 的 id 比较写成 `publicModuleId` 造成的回归（应为 `resolvedModuleId`）
- [x] 4.2 清理单测未传临时 root 时写到仓库根 `public/` 的残留，并确认复跑不再产生
