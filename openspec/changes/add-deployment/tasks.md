# add-deployment — Tasks

约定：远端操作（cheap1/cheap3/Logto/kubectl）每组附验证命令。

## 1. Logto 应用与凭据

- [x] 1.1 auth-admin 控制台新建 SPA 应用 `open-connector-mt-console`：redirect 加 `https://connector.finddatatech.cloud/api/tenant/oidc/callback` 与 `http://127.0.0.1:18999/api/tenant/oidc/callback`。验证：拿 client id，`curl <issuer>/.well-known/openid-configuration` 实测 issuer/jwks_uri。
- [x] 1.2 生成 admin_token 与 encryption_key（openssl rand）。验证：长度与字符集。

## 2. 镜像（cheap3 轨）

- [x] 2.1 （实际改走 GHA——cheap3 本地构建把机器压挂重启，正是 IMAGE-RELEASE.md 要根治的事故）镜像经 scs001/open-connector-mt 私库 publish-tcr 构建推 hkccr fork main，`docker build -t hkccr.ccs.tencentyun.com/yizuo/open-connector-mt:sha-<short> .`。验证：`docker images | grep open-connector-mt`，容器 `docker run --rm -e OOMOL_CONNECT_ADMIN_TOKEN=x <img> healthcheck` 或起容器 curl /health。
- [x] 2.2 cheap3 `/etc/tcr-relay/repos.conf` 加 `yizuo/open-connector-mt` 行（照 wanxing 三行格式）；等 relay 回灌（≤5min）。验证：TCR 控制台/远端 tag 可见。

## 3. 集群

- [x] 3.1 `kubectl --context cheap -n fd-prod create secret generic open-connector-mt`（design D4 键集）。验证：`kubectl get secret open-connector-mt -o jsonpath='{.data}' | jq keys`。
- [x] 3.2 fd-infra-deploy 提交 `all-services/prod/open-connector-mt.yaml`（PVC 2Gi + Deployment TENANCY=oidc + Service ClusterIP 3000 / NodePort 31882）并推送 gitee；ArgoCD 同步。验证：pod Running、`/health` 经 ClusterIP 可达（`kubectl run curl --rm -it --image=curlimages/curl -- http://open-connector-mt:3000/health`）。

## 4. 出口

- [ ] 4.1 cheap1 Caddy（Caddy 块已加并 reload；**余 DNS A 记录 + 雷池站点两步待用户/下轮**——DNSPod 无登录态、雷池需 UI） 加 `connector.finddatatech.cloud` site 块（反代 cheap3:31882，仅 `/`、`/assets/*`、`/api/tenant/*`、`/oauth/*`、`/health`，其余 404）；reload。验证：`curl -sI https://connector.finddatatech.cloud/health` 200；`curl -sI https://connector.finddatatech.cloud/api/auth/session` 404。

## 5. 冒烟与收口

- [ ] 5.1 四点冒烟（集群内三项已绿：health/oidc-config/admin 域 + MCP 匿名 401；真实 Logto 登录待公网域名）：/health 200；真实 Logto 登录（浏览器）建租户进面板；面板建 API key 连接（用真 GitHub token）成功落库；铸 PAT 并 curl MCP `/mcp` tools/list 200。验证：逐项留痕。
- [x] 5.2 fork 提交全部工件（GHA workflow、change 目录）并推送；更新 tasks 勾选；记忆落盘。
