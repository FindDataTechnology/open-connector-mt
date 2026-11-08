# 应用目录的图标随镜像分发，不再在渲染时请求第三方域

## Why

卡片墙要求「每张卡片显示图标」，但**没规定图标从哪来**。上游插件只把
`service → iconUrl` 映射编进包，图标本身指向 `static.oomol.com`，而
`ProviderIcon` 还有一层 favicon 服务兜底——也就是大多数卡片在**浏览器渲染时**
才去抓外部域：

- 内网/离线部署：抓不到，全部退化成首字母色块，而且没有任何错误可见；
- 公网部署：每开一次目录页就是几十到上千个第三方请求，且上游一旦改路径就静默掉图。

2026-11-08 实测：1570 个 provider 里只有 447 个能在包里命中官方 logo（其余走 favicon），
而 OOMOL 目录本身是 1716 个应用全部带图标。资源是有的，只是没落到我们自己的发行物里。

## What Changes

- `web/provider-icons-plugin.ts`：构建期把目录里的图标逐个下载到
  `web/public/provider-icons/`（并发 8、15s 超时、每次构建先清空），并把映射改写成
  `/provider-icons/<service>.<ext>`；vite 自动拷进 `dist/web`。
- 单个图标下载失败：该 provider 保留远程 URL，构建日志按聚合条数报告，**不打断构建**。
- `PROVIDER_ICONS_REMOTE=1` 跳过下载（本地迭代）；目录 gitignore，不把二进制塞进仓库。
- `web/src/locales/fr.json`：`userCatalog.matchCount` 与英文同形被 i18n 断言判为未译，
  改成 `{{count}} services disponibles`。

非目标：不换图标源、不做图片压缩/缩放（原样分发，23MB）、不动 `ProviderIcon` 的三档
回退顺序（本地路径现在自然落在第一档，远程与 favicon 仍作为兜底保留）。

## Impact

- 影响面：控制台前端发行物。镜像 +23MB（1716 个文件），覆盖 1570 个 provider 中的 1565 个
  （99.7%）；渲染路径上的第三方请求降为 0。
- 无 API、无数据、无租户可见的行为变更；目录不可达时仍按原样降级为空映射。
