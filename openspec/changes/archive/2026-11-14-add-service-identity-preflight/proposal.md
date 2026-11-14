# add-service-identity-preflight

## Why

服务令牌代调（`service_pat` + `x-oo-connector-actor-sub`）在连接器侧已实现完整，但对**调用方**只暴露一个二值答案：能用 / 不能用。

而「不能用」有五种互不相同的原因，修法也分给三类人：

| 原因 | 现象 | 谁来修 | 怎么修 |
|---|---|---|---|
| `actor_header_missing` | 401 | 调用方 | 请求里带上 actor 头 |
| `obo_disabled` | 401 | 运维 | 把部署的 `SERVICE_OBO` 从 `off` 翻档 |
| `actor_unregistered` | 401 | 该用户 | 去连接器登录一次（身份只在 OIDC 回调登记） |
| `actor_disabled` | 401 | 运维 | 恢复被停用的身份 |
| `consent_missing` | 401 | 该用户/管理员 | 补建（服务, 租户）consent 行 |

`requireUser` 把这五种塌缩成一个裸 401，这对**授权**是对的（不泄漏内部状态），对**修复**没用。壹座侧要做「代访客调连接器」，就必须能说清「你在连接器登录一次就好」还是「找运维开档位」——否则只能靠猜，猜错的后果是把「档位没开」当成「你没登录」，让用户反复登录一个根本不打算放行的部署。

本变更只加**一个只读诊断面**，不改变任何授权判定。

## What Changes

- `TenantAuthHooks` 新增 `explainService(context, tokenId)`：返回「以谁的身份、或为什么不行」的**带原因**结果。
- 判定逻辑抽成单一的 `serviceIdentityOf`，`resolve()` 与 `explainService()` **都调用它**——这是「诊断不得比授权更宽」的实现保证，不是注释承诺。
- 新增 `GET /api/tenant/service-whoami`：只对服务令牌作答（其他令牌 403，明确「这不是给用户令牌的接口」），按原因逐条给 401 + 机器可读的 `error.code`。
- 该路由置于 `/api/tenant/*` 的 principal 门**之前**并加入白名单：它要回答的正是「principal 解析失败的原因」，被那道门挡住就永远答不出来。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `tenant-auth`: 新增「服务身份可预检」要求；`服务主体代调（OBO）` 的判定收敛到单一实现。

## Non-goals

- **不把诊断面变成授权面的旁路**：`service-whoami` 只回答身份问题，不执行任何动作、不返回连接或动作列表、不签发凭证。
- **不对外暴露原因**：路由只在 `/api/tenant/*`（需已认证的租户域或服务令牌）下提供；匿名请求拿不到任何原因。
- **不改 OBO 的语义与档位默认**：`off` 仍是默认，翻档仍是运维动作。
- **不为 user_pat 提供诊断**：user_pat 不存在代调，问「我为什么不能代调」本身就是错误问题。
- **不做 JIT 登记**：`actor_unregistered` 就是如实报出，不在诊断路径上建身份。

## Impact

- **代码**：`src/server/tenancy/tenant-auth.ts`（`explainService` + `serviceIdentityOf` 单一实现）、`src/server/tenancy/tenant-routes.ts`（新路由 + 失败文案表）。
- **API**：新增一个只读端点。无变更的既有端点。
- **DB**：无迁移。
- **TENANCY=off**：`/api/tenant/service-whoami` 回答 404 `tenancy_disabled`（与其余 `/api/tenant/*` 路由一致）；上游行为零改动。
- **验收**：五条原因各一用例、非服务令牌 403、成功路径返回 actor 租户、以及「预检与 `resolve()` 在同一时刻给出同一结论」（翻档前后各断言一次）；`openspec validate add-service-identity-preflight --strict`。

## 与 paas 侧变更的关系

`paas/openspec/changes/add-served-agent-connector-access` 的 D7.1 把本变更列为**必要前置**：那侧要求「代调失败时告诉用户是去登录还是找运维」，只有本变更能让这两个答案可区分。两仓变更可以各自独立交付，但本变更先合入才能验收那侧的 D5/D6 体验要求。
