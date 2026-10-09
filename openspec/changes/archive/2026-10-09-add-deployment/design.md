# add-deployment — Design

## Context

上游 docker/Dockerfile 多阶段（node:24-alpine，catalog 代码生成 + web 构建，`/app/data` VOLUME，`open-connector` entrypoint 已 chmod 755）。fd-prod 在 **cheap** 集群（kubectl --context cheap），GitOps 真源 fd-infra-deploy（gitee）→ ArgoCD `all-services-prod`。GHA 在 fork 仓库被组织 Actions 策略拦截（push/PR 双路零 run 实锤）。

## Goals / Non-Goals

目标：一条可重复的镜像→TCR→relay→集群线 + 最小暴露面（UI/OAuth 出公网，MCP/admin 留集群内）。Non-goals 见 proposal。

## Decisions

### D1 镜像双轨（cheap3 先行，GHA 常规化）

- **首版**：git push 到 cheap3 工作树 → `docker build`（node-only，估 2-4G 磁盘；cheap3 现剩 6.8G，构建前先 `docker image prune -f` 清 dangling 之外的全部悬空层——registry 事故教训：legacy builder 勿 prune dangling 不适用此场景，见 D3）→ `docker save | gzip | ssh` 回本机 → `docker import` 本机 → `docker push` TCR？**不通**：本机无 TCR 凭据。改走 **relay 回灌**：cheap3 build+tag `hkccr.ccs.tencentyun.com/yizuo/open-connector-mt:sha-x` → cheap3 无 TCR push 凭据 → 用 **tcr-relay 线**：镜像 tag 后写入 cheap3 本地 registry 目录由 relay 清单认领（repos.conf 加行 + relay ≤5min 回灌 ccr）。以 fd-registry/wanxing 先例（deploy/README 一次性前置 #2）为准：**relay 只认清单，≤5min 回灌**。
- **常规**：`publish-tcr.yml`（GHA）org 放行后启用——secrets `TCR_USERNAME`/`TCR_PASSWORD` 逐仓设置（wanxing 三仓同法）。

### D2 暴露面

Service 双 port：`http` 3000（ClusterIP，壹座/谦面/萬星集群内消费 MCP `/mcp`）+ `ui` NodePort 31882（Caddy 反代 UI/OAuth 回调）。admin token 域（`/api/*` 非 tenant）不暴露公网——Caddy 只反代根路径 + `/oauth/callback` + `/api/tenant/*`。真实暴露清单：`/`、`/assets/*`（console shell）、`/api/tenant/*`、`/oauth/*`、`/health`。其余路径 Caddy 返回 404。

### D3 磁盘纪律（cheap3 78%）

构建前 `docker system df` 复查；build 用 `--rm`；结束后清理本次 build cache（`docker builder prune -f --filter until=1h` 保守版）。registry 事故的 "legacy builder 勿 prune dangling" 针对 registry 自身镜像层，不约束 build cache。

### D4 Secret 组装

`kubectl create secret generic open-connector-mt --from-literal=...`（键全小写下划线，照 wanxing-fleet 惯例）：admin_token（openssl rand 32B hex）、encryption_key（openssl rand 32B base64）、oidc_client_id（Logto）、jwks_uri/jwt_issuer（`https://auth.finddatatech.cloud/oidc/jwks`、`https://auth.finddatatech.cloud/oidc`——以 Logto 实际 issuer 为准，创建应用后 `.well-known/openid-configuration` 实测）、jwt_audience=oidc_client_id、locale_default=zh-CN、service_obo=allow-all。

### D5 回滚

ArgoCD revert fd-infra-deploy 提交；PVC 只前进不删（数据保全）；Caddy 条目与 DNS 撤销独立无副作用；Logto 应用停用即可作废全部登录。

## Risks / Trade-offs

- cheap3 磁盘 78%：构建失败即中止改 GHA 轨（需用户先放行 org Actions）——两轨互为备份。
- Logto issuer 实测可能与 `https://auth.finddatatech.cloud/oidc` 不同（swagger 端点 vs OIDC 路径），以 `.well-known` 实测为准写 secret。
- NodePort 31882 若被占用（集群 NodePort 池），apply 时即报错，换号重排。
