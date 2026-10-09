# add-multi-tenancy — Design

## Context

上游 v1.8.0（cdd4b59）：Hono 单进程，`src/server/api/auth.ts` 一个中间件管两种凭证（admin token + HMAC cookie 会话 / runtime `oct_` token 或 JWKS JWT，`auth.ts:46-119`，挂载点 `connect-server.ts:212`）；storage 三方言共享接口（`node-runtime-database.ts:43-56`），纯 SQL 迁移按文件名序应用；MCP 为无状态 streamable HTTP、固定 5 工具（`src/mcp.ts:127-174`）；console React 19 由同进程托管（`server/index.ts:119`）。租户维度的唯一现成挂钩：`connection_requests.owner` 列（恒为 `"local-admin"`）、runtime token 的 grant 列（allowed_connections 等）、`runtime-jwt.ts` 的 JWKS 验签路径。

硬约束（ADR-0001 + config）：`TENANCY=off` 字节级兼容；fork delta 薄、集中新文件；`src/providers/**` 不改；上游文件触碰是最小例外。

## Goals / Non-Goals

**Goals**：租户数据层一次到位（组织层零手术可加）；三层令牌映射到上游既有机制（PAT=runtime token 加 kind，OIDC=扩展 JWKS 路径）；MCP/console 的租户面最小侵入；双语改动形状可长期合并。

**Non-Goals**：组织租户、BYO-app UI、consent 管理 UI、目录翻译、D1 MT、壹座/部署接线（独立 change）。

## Decisions

### D1 数据模型与迁移（migration 0018，双方言）

新表（fork 新文件 `migrations/0018_multi_tenancy.sql` + `migrations/postgresql/0018_multi_tenancy.sql`；上游 0017 为最新，号段顺延）：

```sql
-- SQLite 方言；PG 方言同构（TEXT→uuid 由应用层约定，TIMESTAMP 语义不变）
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,                      -- 内部 uuid
  kind TEXT NOT NULL DEFAULT 'user',        -- 'user'（组织层预留扩展位）
  created_at TIMESTAMP NOT NULL,
  disabled_at TIMESTAMP
);
CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT, display_name TEXT,
  created_at TIMESTAMP NOT NULL,
  disabled_at TIMESTAMP,
  UNIQUE(issuer, subject)
);
CREATE TABLE consents (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  token_id TEXT NOT NULL,                   -- service_pat 的 runtime_tokens.id
  granted_at TIMESTAMP NOT NULL,
  PRIMARY KEY (tenant_id, token_id)
);
ALTER TABLE connections          ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local-admin';
ALTER TABLE oauth_states         ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local-admin';
ALTER TABLE oauth_client_configs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'platform';
ALTER TABLE runtime_tokens       ADD COLUMN tenant_id TEXT;          -- service_pat 为 NULL
ALTER TABLE runtime_tokens       ADD COLUMN kind TEXT NOT NULL DEFAULT 'runtime';
ALTER TABLE runs                 ADD COLUMN tenant_id TEXT;
-- connections 主键重建（照上游 0006 的重建套路）：
--   新表 (tenant_id, service, connection_name) 为主键，拷贝数据，换名。
```

理由：`tenant_id` 落 `tenants.id` 而非 identities，组织层将来只加 `org_memberships` 不动列（拷问 Q12 升级定案）。`platform` 作为 oauth_client_configs 的默认租户 id：平台级 app 是"一行多租户共享"，解析序 tenant 行 → platform 行（v1 只有 platform 行可写）。旧数据默认值 `local-admin` 即引导租户，天然满足 off 档兼容。PG 迁移由 `open-connector migrate` 子命令路径应用（上游机制不变）。

### D2 认证中间件：新文件承载，挂载点最小触碰

新文件 `src/server/api/tenant-auth.ts`：`TENANCY=oidc` 时的 OIDC 验签（jose，复用上游 `runtime-jwt.ts` 的 JWKS 缓存模式）、identity 首见登记、PAT→租户解析、OBO actor 解析与 consent 判定。返回统一的 `TenantPrincipal { tenantId, identityId?, tokenId?, kind, actorTenantId? }` 挂到 Hono context。

上游触碰仅两处 wiring：`auth.ts` 中间件工厂加 tenancy 分支（off → 原路径原样；oidc → 先走 tenant-auth 再落原 scope 判定）；`connect-server.ts:212` 挂载处传参。admin token 判定保持原逻辑且在 MT 模式额外注入 `TenantPrincipal { kind:'admin' }`（跨租户权）。

OIDC console 登录（PKCE 公共客户端）：新增 `src/server/api/tenant-routes.ts` 承载 `/api/tenant/*`（login-url / callback 代理 code 交换 / session / logout / pats CRUD / connections CRUD 走既有 admin 域实现但限定租户）。code 交换经服务端代理（萬星 facade logto-auth.js 的既有模式，浏览器不碰 token endpoint 的 CORS）。

### D3 PAT 与 OBO：骑在 runtime_tokens 上

user*pat/service_pat 都是 `runtime_tokens` 行：`kind` 区分，`tenant_id` 绑定（service_pat 为 NULL）。铸造走 console 的租户路由（内部调用上游 runtime-token-service 的哈希/存储逻辑，前缀仍 `oct*`——不发明第二套令牌格式）。grant 列照旧生效（租户校验在策略判定之前，两者叠加而非替代，见 tenant-mcp spec）。

OBO：`x-oo-connector-actor-sub` 头（子属 configured issuer）；仅 `kind='service_pat'` 的令牌具代调资格；`SERVICE_OBO` 三档在 `tenant-auth.ts` 判定；执行时有效租户 = actor 租户，`runs` 落 `tenant_id` + value 里记 service token id 与 actor identity（审计）。

### D4 存储层：装饰而非分叉

新文件 `src/server/storage/tenant-store.ts`：tenants/identities/consents 的 CRUD + connections/oauth_states 的租户限定包装（where tenant_id = ?）。上游 store 接口不动签名——租户限定经调用方（路由/服务层）传参实现，避免给三方言 store 各打补丁。`.cases.ts` 新增 `tenant-store.cases.ts` 进 SQLite/PG 双矩阵；D1 方言文件照抄上游目录惯例。

`connection-service.ts` 的连接读写入口（`connection-service.ts:1101` 一带）是唯一需要加租户参数的既有服务层触碰：函数签名加可选 `tenantId`（缺省 = 引导租户，off 档调用点零改动）。

### D5 MCP：构造参数注入过滤

`src/mcp.ts` 的 `createMcpHandler` 增加可选 `principal` 参数（fork 新增的 options 字段）：`list_connections` 过滤、`execute_action` 归属校验（找不到/越界同抛 `connection_not_found`）。上游触碰 = `connect-server.ts:417-427` 挂载处把 context 里的 principal 传入 + `mcp.ts` 内两处工具实现加过滤行。目录三工具不动。

### D6 console：用户面板全部新文件 + i18n 机械包裹

- `web/src/user/*`：面板页（连接列表/新建/OAuth 发起/PAT 管理/试跑），react-router 新路由段 `/me`；上游触碰仅 router 表加一行 + 导航判断（TENANCY 配置经 `/api/tenant/config` 下发）。
- `web/src/i18n/*`：`zh-CN.json`/`en.json` + 轻量 `t()`（键嵌套点路径，零新增依赖）；上游组件不批量改写——**只包我们新增的面板**；admin 视图文案 i18n 仅覆盖菜单级少量键，正文表格数据本就来自 API 不需翻译。此边界把 web/ diff 压到可合并形状（拷问 Q15 双语定案的可执行落法）。
- 语言解析：localStorage 偏好 > `LOCALE_DEFAULT` > `navigator.language` 检测 > en；缺失键回退 en。

## Risks / Trade-offs

- **上游合并冲突面**：`auth.ts`/`connect-server.ts`/`mcp.ts` 是上游活跃文件。缓解：D2/D4/D5 全部"新文件承载逻辑、既有文件只加 wiring 行"；双周合并窗口先跑 `.cases.ts` 矩阵再合。
- **租户校验遗漏面**：任何绕过包装直接查 store 的新代码都是泄漏点。缓解：tenant-store 包装作为唯一租户限定入口写进 CONTRIBUTING 约定；跨租户不可探测场景进 e2e。
- **`oct_` 前缀复用**：PAT 与上游 runtime token 同前缀，外部无法从令牌形态区分 kind——这是有意的（不泄漏令牌身份类别），判定只看库中 kind 列。
- **consent 行的 token_id 外键**：指向 runtime_tokens.id，服务 PAT 撤销后 consent 行成孤儿——删除 PAT 时级联清 consent（v1 实现，无 schema 影响）。
- **PG/D1 差异**：D1(CF) 在 MT 模式启动即拒（`node-runtime-database.ts` 增一个启动检查）；PG 走既有 migrate 子命令，双方言迁移的 SQL 差异仅在时间戳/默认值语法，随 .cases.ts 双矩阵验证。
