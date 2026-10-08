# add-multi-tenancy

## Why

上游 open-connector 严格单租户——owner 是硬编码常量 `local-admin`（`src/server/api/connection-routes.ts:30`、`src/server/connect-server.ts:366`），全库无任何用户/租户维度。产品需要的是：每个用户（经统一 OIDC 登录中心，我方为 Logto）自助存储和管理自己的连接凭证、凭证永不出库，壹座（paas cells，per-user PAT + MCP 挂载）、谦面（facet agent 服务，service PAT + actor 头代调）、萬星 agents 三个平面按用户隔离消费。经探索与拷问定案（ADR-0001）：公开分叉加**原生多租户**，以 env 门控保持可上游化。

## What Changes

- **租户模型**：新增 `tenants`（kind='user'，组织层预留）与 `identities`（OIDC `(issuer, subject)` 首见登记，无密码面）两表；`TENANCY=off`（默认）时一切行为与上游字节级兼容——所有行落引导租户 `'local-admin'`，identities 空表。
- **存储租户化**（migration `0018_multi_tenancy`，SQLite/PG 双方言）：`connections`/`oauth_states`/`oauth_client_configs`/`runtime_tokens` 增加 `tenant_id` 列；`connections` 主键由 `(service, connection_name)` 重建为 `(tenant_id, service, connection_name)`；`runtime_tokens` 增加 `kind`（runtime/user_pat/service_pat）；`runs` 增加租户列供审计过滤；新增 `consents` 表。
- **三层令牌**：① 浏览器会话 = OIDC（console PKCE 公共客户端，code 交换经服务端代理，扩展上游既有 JWKS 验签路径 `src/server/api/runtime-jwt.ts`）；② **user_pat**——fork 铸造的每用户令牌（`oct_` 前缀、SHA-256 落库、软撤销、绑定唯一租户），供 agent/MCP 面；③ **service_pat + `x-oo-connector-actor-sub` 头代调**（OBO），consent 三档 env `SERVICE_OBO=off|allow-all|consent`（开源默认 off，我方部署 allow-all 起步），actor 落 runs 审计。admin token 保留为运维兜底（跨租户全权）。
- **MCP 面租户过滤**：上游 5 工具面不动形状，`list_connections` 按调用方租户过滤、`execute_action` 校验连接归属。
- **console 用户面板**：连接全生命周期（列表/新增 API key/发起 OAuth/删除/改名/过期与 reauth 状态/试跑 Action）+ PAT 铸造与撤销；admin 全局视图原样保留。**双语 zh-CN/en**：locale 文件 + `t()` 机械包裹，浏览器检测 + 手动切换 + 持久化，部署可设默认语言（我方 zh-CN、开源发布 en）。
- **D1/Cloudflare 方言在 MT 模式下启动即拒**（"多租户需 Node runtime"），非残缺而是诚实边界。
- 无 **BREAKING**：默认 `TENANCY=off` 下现有部署升级 fork 后行为不变。

## Non-goals

- 组织租户（schema 预留 `tenants.kind` + identity 归属形状，不加 org_memberships）
- 租户自带 OAuth app 的管理界面（`oauth_client_configs.tenant_id` 列与解析序预留，UI 后置）
- consent 强制档的管理界面（表 v1 落库、三档 env 就绪，consent 行先经 admin API）
- provider 目录（`src/providers/**`）的任何修改与翻译；API 错误码翻译
- 谦面 registry 目录注册（PAT 直连即可达，registry 按用户身份转发属远期）
- 部署清单与壹座 cell 接线（fd-infra-deploy yaml、registry-credentials 泛化）——独立 change 处理

## Capabilities

### New Capabilities

- `multi-tenancy`: 租户/身份/引导租户模型，存储层（connections/oauth_states/oauth_client_configs/runtime_tokens/runs）的租户化与隔离不变量
- `tenant-auth`: OIDC 验签与首见登记、user_pat/service_pat 铸造与撤销、OBO actor 头与 consent 三档、TENANCY 开关语义
- `tenant-mcp`: MCP 端点在多租户模式下的连接可见性与执行归属校验
- `tenant-console`: 用户面板（连接生命周期 + PAT 管理）、双语机制与语言默认值

### Modified Capabilities

（无——本仓为 fork 新立 openspec 根，尚无既有 specs）

## Impact

- **上游文件触碰清单**（每处均为不可避免的最小触碰，理由随附）：
  - `src/server/index.ts`——新增 env 解析（TENANCY/OIDC/SERVICE_OBO/LOCALE_DEFAULT）
  - `src/server/api/auth.ts`——中间件挂载点分叉 tenancy 分支（新文件承载实现，此处只加 wiring）
  - `src/server/connect-server.ts`——路由注册处接入租户中间件与用户面板路由（触碰压到 import + 挂载行）
  - `src/server/storage/node-runtime-database.ts` + `sqlite/`/`postgres/` store——新表接入（.cases.ts 共享用例随迁）
  - `src/mcp.ts`——list_connections/execute_action 注入租户过滤（经构造参数注入，改动数行）
  - `web/`——路由与菜单挂载用户面板入口（面板本体全部新文件）
- **新文件布局**：`src/server/api/tenant-auth.ts`、`src/server/storage/tenant-store.ts`、`src/server/api/tenant-routes.ts`、`web/src/user/*`、`web/src/i18n/*`、`migrations/0018_multi_tenancy.sql` + `migrations/postgresql/0018_multi_tenancy.sql`
- **测试**：新表 .cases.ts 进 SQLite/PG 双方言矩阵；tenant-auth（含 OBO 三档）、MCP 过滤、console 双语各有测试文件
- **依赖**：console OIDC 登录用上游已有的 `jose`，零新增运行时依赖
- **关联仓**：fd-infra-deploy（部署清单）、paas（壹座接线）各立 change
