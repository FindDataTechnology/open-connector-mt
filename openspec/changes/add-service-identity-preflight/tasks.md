# Tasks — add-service-identity-preflight

## 1. 判定收敛到单一实现

- [x] 1.1 `tenant-auth.ts`：把「服务令牌能否以 actor 执行」抽成 `serviceIdentityOf(context, store, cfg, tokenId)`，返回 `{ok:true,tenantId,tokenId}` 或 `{ok:false,code}`（五值联合）。验证：`resolve()` 的服务令牌分支只消费该结果，不再自带判定。
- [x] 1.2 `TenantAuthHooks` 增 `explainService(context, tokenId)`，实现直接转调 `serviceIdentityOf`。验证：hook 对象里不存在第二份判定代码。

## 2. 诊断端点

- [x] 2.1 `tenant-routes.ts`：`GET /api/tenant/service-whoami`。非服务令牌 403 `not_a_service_token`；`hooks` 缺失（TENANCY=off）404 `tenancy_disabled`；失败按原因 401；成功 200 `{ok,tenantId,tokenId}`。
- [x] 2.2 路由置于 `/api/tenant/*` 的 principal 门之前并加入白名单（否则「principal 为何解析失败」永远问不出来）。
- [x] 2.3 每条原因配一句可操作的文案（`SERVICE_DENIAL_MESSAGES`），文案说明**该谁去修**。

## 3. 用例

- [x] 3.1 五条原因各一用例，断言状态与 `error.code` 精确相等。
- [x] 3.2 `actor_disabled` 用 `setIdentityDisabled(id, true)` 构造，断言与 `actor_unregistered` 可区分。
- [x] 3.3 非服务令牌 403；成功路径返回 actor 租户与令牌 id。
- [x] 3.4 一致性用例：同一请求先断言诊断 200 且 `/api/tenant/session` 也 200，翻档 `off` 后两者同时 401。
- [x] 3.5 **能红**：把 `obo_disabled` 与 `actor_unregistered` 合并成同一 code，`actor_unregistered` 用例必须红且其余仍绿（已实测：1 failed | 6 passed）。
- [ ] 3.6 TENANCY=off 下 404 `tenancy_disabled` 的用例（当前缺）。

## 4. 验收

- [x] 4.1 `node scripts/typecheck.ts` 通过。
- [x] 4.2 `npx vitest run src/server/tenancy/` 63/63 通过。
- [ ] 4.3 `openspec validate add-service-identity-preflight --strict` 通过。
- [ ] 4.4 归档时对账：`+ 1 added, ~ 1 modified`，并 `openspec validate tenant-auth --type spec --strict`。

## 5. 文档

- [ ] 5.1 `docs/runtime-api.md`（或等价的认证文档）记一条：代调失败的四种修复动作与对应错误码。
