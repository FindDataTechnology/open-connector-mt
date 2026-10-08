# add-deployment

## Why

`add-multi-tenancy` 已实现并推送（d1e9e80），但没有部署实例三个消费面都无从验证：壹座 cell 要挂载它的 MCP、谦面 facet agent 服务要拿 service PAT、萬星 agents 同构消费。按萬星三件套已验证的 GitOps 管线把 open-connector-mt 带上 fd-prod。

## What Changes

- **镜像**：fork 新增 GHA 工作流 `publish-tcr.yml`（构建上游 docker/Dockerfile → `hkccr.ccs.tencentyun.com/yizuo/open-connector-mt:sha-<short>`）；当前组织 Actions 策略拦 fork 仓库（run 零触发，已实锤 push/PR 双路），首版镜像改走 cheap3 本地构建 + `docker save | ssh import` → TCR relay 线，GHA 作为 org 放行后的常规线并存。
- **部署清单**：fd-infra-deploy `all-services/prod/open-connector-mt.yaml`（照 wanxing-facade 模板）——PVC 2Gi（SQLite 只前进不回滚）+ Deployment（port 3000，`TENANCY=oidc`，env 自 `open-connector-mt` secret）+ Service（ClusterIP 3000 供集群内 MCP 消费 + NodePort 31882 供 cheap-1 Caddy 出口）。
- **Secret**：fd-prod ns `open-connector-mt`——`admin_token`/`encryption_key`（本 change 生成）、`oidc_client_id`/`jwks_uri`/`jwt_issuer`/`jwt_audience`（新 Logto SPA 应用）、`locale_default=zh-CN`、`service_obo=allow-all`。
- **Logto**：auth-admin 控制台新建 SPA 应用（redirect = `https://connector.finddatatech.cloud/api/tenant/oidc/callback` + `http://127.0.0.1:18999/api/tenant/oidc/callback` 冒烟用），client id 入 secret。
- **出口**：cheap-1 Caddy `connector.finddatatech.cloud` → cheap3 NodePort 31882（照 wanxing-web 条目抄）；域名走既有通配/解析。
- **冒烟四点**：/health、真实 Logto 登录建租户、API key 连接创建、PAT 铸造 + MCP list/execute。

## Non-goals

- 壹座 cell 接线（PAT 落 cell + MCP 挂载）——独立 change
- 谦面 facet agent 的 service PAT 发放与 actor 头接线——独立 change
- consent 管理界面、BYO-app、组织租户（见 add-multi-tenancy Non-goals）
- GHA Actions 组织策略修复（用户侧操作：org Settings → Actions → 允许 `open-connector-mt`）

## Impact

- 新文件：`.github/workflows/publish-tcr.yml`（fork）、`fd-infra-deploy/all-services/prod/open-connector-mt.yaml`、cheap-1 Caddyfile 一条 site 块、cheap-3 tcr-relay repos.conf 一行
- 集群：fd-prod 新增 PVC/Deployment/Service/Secret 各一
- Logto：新增一个 SPA 应用
- 资源：限额内 192Mi requests / 768Mi limits（轻 Node 服务，同 facade）
