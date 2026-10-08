# add-multi-tenancy — Tasks

约定：标 **[UP]** 的任务触碰上游既有文件（对照 design 的触碰清单）；其余全部落 fork 新文件。每组可独立验证。

## 1. 仓库与基线

- [x] 1.1 GitHub 建可见 fork：`gh repo fork oomol-lab/open-connector --org FindDataTechnology --clone=false` 后 rename 为 `open-connector-mt`；本地仓添加 remotes（`origin`=fork、`upstream`=oomol-lab），确认 HEAD 停在 v1.8.0（cdd4b59）。验证：`git remote -v` + `git describe --tags`。
- [x] 1.2 基线绿：`npm ci && npm run typecheck && npm test`（Node ≥22.18）全绿留档，作为 fork 的合并基线。验证：本地跑通，输出存 `openspec/changes/add-multi-tenancy/` 外的会话记录。

## 2. 数据层（migration 0018 + tenant-store）

- [x] 2.1 写 `migrations/0018_multi_tenancy.sql`（tenants/identities/consents 三表 + 五列 + connections 主键重建，见 design D1）。验证：SQLite 全新库启动自动应用无错。
- [x] 2.2 写 `migrations/postgresql/0018_multi_tenancy.sql` 同构 PG 方言。验证：`open-connector migrate` 对 PG 空库与带 0017 数据的库各跑一次成功。
- [x] 2.3 新文件 `src/server/storage/tenant-store.ts`：tenants/identities/consents CRUD + connections/oauth_states 租户限定包装。**[UP]** `node-runtime-database.ts`（新表注册 + MT-on-D1 启动拒绝）。验证：新增 `tenant-store.cases.ts` 进 SQLite/PG 双矩阵全绿。
- [x] 2.4 存量兼容验证：对 off 档（TENANCY 未设）跑上游既有 store 全部 `.cases.ts` 不变绿（默认值落引导租户，行为零变化）。验证：vitest 双方言矩阵。
- [x] 2.5 身份删除级联：删除 identity 级联清其租户连接/PAT/consent。验证：tenant-store.cases.ts 增级联用例。

## 3. 认证层（tenant-auth + PAT + OBO）

- [x] 3.1 新文件 `src/server/api/tenant-auth.ts`：`TENANCY` 开关解析、OIDC 验签（jose + JWKS 缓存，issuer/aud/exp 校验）、identity 首见登记、`TenantPrincipal` 产出；`TENANCY=oidc` 而 OIDC 未配置时启动 fail-fast。验证：新测试文件覆盖验签通过/过期/issuer 不符/audience 不符/首见建租户/复用/停用拒绝。
- [x] 3.2 **[UP]** `src/server/api/auth.ts` + `src/server/connect-server.ts`（仅 wiring）：中间件分支——off 走原路径原样；oidc 先 tenant-auth 再原 scope 判定；admin token 注入跨租户 principal。验证：off 档既有 auth 测试全绿不动；MT 档新增路径测试。
- [x] 3.3 PAT：租户路由铸造/撤销 user_pat（kind 落库、SHA-256、明文一次性返回、`oct_` 前缀）；撤销即 401。验证：铸造→调用→撤销→401 的接口级测试。
- [x] 3.4 OBO：service_pat + `x-oo-connector-actor-sub`；`SERVICE_OBO` 三档判定（off 403 / allow-all 放行 / consent 查表）；actor 未登记或停用 403；user_pat 带头忽略；runs 落 tenant_id + service/actor 审计。验证：三档 × 两种令牌的矩阵测试。

## 4. 租户路由（面板 API）

- [x] 4.1 新文件 `src/server/api/tenant-routes.ts`：`/api/tenant/*`（config 下发 / OIDC login-url + callback 代理 / session / logout / connections CRUD / OAuth 发起透传（connectionName 自动命名）/ PAT 管理 / action 试跑）。**[UP]** `connect-server.ts` 挂载（import + 一行）。验证：以测试 identity 走全流程的接口测试。
- [x] 4.2 OAuth 回调租户绑定：授权发起把 tenant_id 写入 oauth_states，回调落对应租户连接。验证：两租户并发发起同 provider OAuth，各自回调互不串扰。

## 5. MCP 租户过滤

- [x] 5.1 **[UP]** `src/mcp.ts`（数行）+ `connect-server.ts` 挂载传参：`list_connections` 按租户过滤、`execute_action` 归属校验（越界=connection_not_found 同形）；目录三工具不动。验证：MCP 测试加双租户用例（各自 list/execute、越界探测同形、off 档不变）。

## 6. Console（用户面板 + 双语）

- [x] 6.1 新文件 `web/src/i18n/*`（zh-CN.json/en.json + `t()`）；语言解析链 localStorage > LOCALE_DEFAULT > navigator > en。验证：单测覆盖解析链与缺失键回退。
- [x] 6.2 新文件 `web/src/user/*`：连接列表（状态徽标）/API key 新建/OAuth 发起/删除/改名/PAT 铸造撤销/Action 试跑页。验证：vitest web 组件测试 + 双语快照。
- [x] 6.3 **[UP]** router 与导航挂载 `/me` 路由段（各一行级触碰）；off 档不渲染入口。验证：`TENANCY` 两档下 console 渲染测试。

## 7. 端到端与收口

- [x] 7.1 跨租户不可探测 e2e：双租户数据 + 越权 list/execute/guess 全部同形 `connection_not_found`/空列表。验证：e2e 脚本绿。
- [x] 7.2 全量回归：`npm run typecheck && npm test` 双方言 + oxlint/oxfmt（上游 CI 序）全绿。验证：与 1.2 基线对照零退化。
- [x] 7.3 冒烟剧本：TENANCY=oidc 起本地实例 → OIDC 登录（测试 issuer）→ 建 API key 连接 → 铸 PAT → MCP execute_action → 撤销 PAT 401；再跑 TENANCY=off 全程无租户面。验证：剧本脚本化留档。
