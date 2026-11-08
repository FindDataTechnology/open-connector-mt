# 租户控制台加一面应用目录（卡片墙）

## Why

`/me` 只有一条「我的连接」列表和一个搜索弹窗。也就是说：**必须先知道名字，才能连**。
1680 个 provider 的分类、图标、认证方式都在 `ProviderDefinition` 里（`/v1/providers`
甚至已经把它们序列化成 `iconUrl` / `homepageUrl` / `categories`），但客户端在
`ui.tsx` 把它们丢了，只留 service/displayName/authTypes；界面上也没有任何「浏览」面，
只有搜索框。对一个要接系统的运营者，这是“要什么自己搜”的工具，不是目录。

上游开源项目已经带了图标设施：`web/provider-icons-plugin.ts` 把 OOMOL 目录的
`service → iconUrl` 编成 `virtual:oomol-provider-icons`，`shared-ui.tsx` 的
`<ProviderIcon>` 做三级回退（provider.iconUrl → 目录 iconUrl → favicon 服务 → 首字母）。
也就是说卡片墙缺的只有容器，不缺资源。

## What Changes

- `web/src/ui.tsx`：`/v1/providers` 的映射不再丢 `iconUrl` / `homepageUrl` / `categories`
  （categories 兼容 `{id,displayName}` 与字符串两种形状）。
- `web/src/user/user-page.tsx`：`ProviderOption` 补上述三个字段；页面在「我的连接」之后
  插入应用目录区；卡片点击把 service 交给既有连接表单（`requestedService` →
  `setService` + 滚动到表单 + 聚焦）。连接实现只有一份，卡片与搜索弹窗是同一道门。
- 新组件 `web/src/user/connector-catalog.tsx`：搜索 + 分类 chip 过滤 + 三列发丝网格
  （1px 间隙压在 border 上，而不是 60 张带阴影的卡），已连接的置顶并显「已连接 · N」，
  免认证的 provider 显「免认证」而不是「去连接」，先渲染 60 张再给「再显示 N 个」。
- `web/src/shared-ui.tsx`：`ProviderIcon` / `providerIconSource` 的入参从完整
  `ProviderDefinition` 收窄为 `ProviderIconTarget`（service/displayName/iconUrl/homepageUrl），
  完整定义仍然满足它——否则目录行得伪造一个 actions 数组才能画图标。
- 六语补齐 `userCatalog.*`（en/zh-CN/zh-TW/ja/fr/ru）。

非目标：不做另一个连接流程；不动 `configurableProviders` 的准入规则；不改上游 admin
控制台的 providers 页；不引入新图标源（沿用 OOMOL 目录 + favicon 回退）。

## Impact

- 影响面：`/me` 一个页面，多了一段可浏览的目录；数据面只是不再丢弃已有字段。
- 无迁移、无 API 形状变更（`/v1/providers` 本来就返回这些字段）。
- 首屏渲染量受 60 张上限约束，搜索/分类切换即时。
