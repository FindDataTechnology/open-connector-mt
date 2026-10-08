## Context

见 proposal.md - Why。约束：

1. `RuntimeTokenService.createToken(name, policy, { kind, tenantId })` 第三参已存在，`summarizeRuntimeToken` 已投影 `kind`/`tenantId`——**存储与投影层无需改动**。
2. 缺的是入口：`src/server/connect-server.ts:1276` 的 `createRuntimeToken` 调 `createToken(name, readTokenPolicy(body, true))`，第三参不传 → 产出 legacy token。
3. `tenant-auth.ts` 的 `resolve` 对 `grant.kind` 分派：`service_pat` 走 `resolveServicePat`（要 actor 头 + `SERVICE_OBO` 档），无 kind 的 legacy token 在 MT 模式被拒。
4. `TENANCY=off` 必须与上游逐字节兼容（config.yaml 硬约束）。

## Goals / Non-Goals

**Goals:**

- admin 域能铸造 `kind='service_pat'` 令牌，明文一次性返回，列表可见可撤销。
- `TENANCY=off` 下未指定 kind 的路径行为与上游完全一致。
- `user_pat` 不可经此路径铸造（它必须绑定身份，只能走 OIDC 会话路径）。

**Non-Goals:**

- 不做 service PAT 的 self-service（服务主体语义决定它归 admin）。
- 不改 OBO 解析与 consent 逻辑。
- 不新增表、不新增迁移。

## Decisions

### D1: 复用 `POST /api/runtime-tokens`，加可选 `kind` 字段；不另开端点

**理由**：令牌管理面已存在且完整（列表/改策略/撤销），另开端点会造出第二个互不相干的令牌清单，撤销与审计都要复制。加一个可选字段是最薄的上游触碰。**替代方案**：fork-new 的 `POST /api/tenant/service-pats`——不动上游文件，但令牌列表会出现"列表里有它、却不由列表端点管"的割裂；且撤销仍要动 `connect-server.ts` 的列表投影，省不下触碰。

### D2: `kind` 白名单只收 `"service_pat"`，其余拒绝

`user_pat` 必须带 `tenant_id`，而 admin 域没有"当前身份"概念——允许从 admin 铸造 user_pat 会造出无主令牌（解析器 `if (!grant.tenantId) return undefined` 会拒绝它，等于铸造即废）。因此请求里的 `kind` 只接受 `"service_pat"`；其他值 400 并说明原因。**替代方案**：同时支持 `user_pat` + 显式 `tenantId` 参数——把跨租户铸造权交给 admin，语义上说得通，但扩大了本 change 的攻击面与测试面，且当前无消费方需要它。

### D3: 校验与拒绝走既有错误形状

未知 kind → 400 `invalid_input`，消息说明只支持 `service_pat`。与 `readTokenPolicy` 的既有校验风格一致（同文件同形状），不引入新的错误码。

### D4: `TENANCY=off` 不设门

不在 off 档禁用该字段：off 档下 service_pat 因 `resolve` 不可达而不被解释，令牌就是个普通 runtime token——与"off 档行为与上游一致"不冲突（上游没有 kind 概念，多存一个列值不改变任何可观察行为）。若强行在 off 档拒绝 `kind`，反而制造分叉。

## Risks / Trade-offs

- **[admin token 泄露即获得代调能力]** → 与既有事实一致（admin 本就跨租户全权，见 `tenant-auth` 的 "admin token 保留" 要求），不新增权限面。
- **[service_pat 无 tenant_id，`runs` 审计靠 actor 头]** → 已是既有设计（3.4 任务），本 change 不改。
- **[触碰上游文件]** → 改动是"可选字段 + 一次条件传参"，off 档逐字节等价；用既有 runtime-token 测试 + 新增 route 级测试兜底。

## Migration Plan

1. 改 `createRuntimeToken` 接受 `kind`（纯代码，无迁移）。
2. 部署后：admin 铸造一个 service_pat → 以 `Authorization: Bearer <pat>` + `x-oo-connector-actor-sub: <已登记 sub>` 调 `/mcp` tools/list → 返回 actor 租户的连接。
3. 回滚：撤镜像；已铸造的 service_pat 在旧镜像下因 kind 被忽略而退化为普通 runtime token（MT 下被拒），无残留危害。

## Open Questions

无——实现路径无未决分叉。
