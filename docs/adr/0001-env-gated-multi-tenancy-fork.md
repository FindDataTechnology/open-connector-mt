# 分叉 open-connector 并以 env 门控实现多租户

上游是严格单租户（owner 硬编码 `local-admin`），而产品需要按用户隔离的连接存储，供壹座/谦面/萬星三个平面消费。我们决定公开分叉（Apache-2.0 沿袭，钉 v1.8.0 起步），多租户以 `TENANCY=off|oidc` 环境门控的加法实现：off（默认）与上游行为字节级兼容，oidc 开启租户路径。目标是双轨——自用即产品，设计保持可上游化（默认行为不变 + 集中在新文件），落地后向上游提 PR。

## Considered Options

- **包裹（facade）而非分叉**：用 named connections 命名约定做租户映射。被否——隔离靠 facade 过滤纪律而非数据层强制，且上游连接名正则 `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$` 不容 `::`，映射先天别扭。
- **复活 Nango**：被否——Elastic License、免费自托管被砍到 Auth+Proxy（MCP 属 Enterprise）、5 服务 ×2GB 的部署足迹。
- **纯自建**：被否——1000+ provider 目录与 10000+ 动作执行器是不可复制的轮子。

## Consequences

- 上游日更、10 天 5 release：v1 上线后双周合并；fork delta 必须薄，改上游文件（connect-server.ts 等）是预算内例外而非常态。
- 租户补丁集中在 auth/storage/mcp/console 四处新文件 + 少量既有文件的最小触碰；`src/providers/**` 永不改。
- D1/Cloudflare 方言在 MT 模式下启动即拒（多租户需 Node runtime），非残缺而是诚实边界。
