## MODIFIED Requirements

### Requirement: 服务主体代调（OBO）

`service_pat` 不属于任何用户租户；凭 `x-oo-connector-actor-sub` 头以指定身份的租户执行。`SERVICE_OBO` 三档管辖：`off`（默认）禁用、`allow-all` 全放行、`consent` 需 consent 行。

判定 SHALL 收敛到单一实现 `serviceIdentityOf(context, store, cfg, tokenId)`：授权路径（`resolve()` → principal）与诊断路径（`explainService()` → 带原因的结果）**MUST** 调用同一函数，使「诊断说能」与「授权放行」不可能出现分歧。

#### Scenario: off 档禁用代调

- **WHEN** `SERVICE_OBO=off` 时携带 actor 头请求
- **THEN** 拒绝（403），无论 service_pat 是否有效

#### Scenario: allow-all 以 actor 租户执行

- **WHEN** `allow-all` 档下有效 service_pat 携带已登记身份的 actor 头执行动作
- **THEN** 以该 actor 租户解析连接并执行，运行记录同时落 service 与 actor 以备审计

#### Scenario: actor 须为已登记身份

- **WHEN** actor 头指向不存在或已停用的身份
- **THEN** 拒绝（403），不自动创建身份

#### Scenario: consent 档强制授权

- **WHEN** `consent` 档下无该（服务, 租户）consent 行
- **THEN** 拒绝（403）；补建 consent 行后放行

#### Scenario: user_pat 不具代调资格

- **WHEN** user_pat 携带 actor 头请求
- **THEN** actor 头被忽略，以 PAT 自身租户执行（代调资格仅属 service_pat）

#### Scenario: 诊断与授权共用同一判定

- **WHEN** 核对任一服务令牌请求的授权结论与其诊断结论
- **THEN** 二者一致；翻档或停用身份后仍一致（实现上只能共用 `serviceIdentityOf`）

## ADDED Requirements

### Requirement: 服务身份可预检

系统 SHALL 提供一个只读诊断端点，回答「这个服务令牌现在能否以某个 actor 的身份执行，若不能是为什么」，使调用方能区分「调用方补一个头」「运维开档位」「用户去登录一次」「补 consent」四种互不相同的修复动作，而不是对着一个裸 401 猜。

原因集合 SHALL 至少包含：`actor_header_missing`、`obo_disabled`、`actor_unregistered`、`actor_disabled`、`consent_missing`。诊断 MUST NOT 比授权更宽，MUST NOT 执行任何动作、MUST NOT 签发凭证、MUST NOT 返回连接或动作清单。

#### Scenario: 服务令牌得到肯定答案

- **WHEN** `SERVICE_OBO` 允许且 actor 头指向一个已登记的启用身份，持有效 service_pat 请求诊断端点
- **THEN** 返回该 actor 的租户标识与该服务令牌标识，状态 200

#### Scenario: 非服务令牌被明确挡回

- **WHEN** 以 user_pat 或 OIDC 会话请求诊断端点
- **THEN** 拒绝（403），错误码指明「本端点只对服务令牌作答」

#### Scenario: 缺 actor 头

- **WHEN** 持有效 service_pat 但请求未带 actor 头
- **THEN** 拒绝，错误码为 `actor_header_missing`

#### Scenario: 运维未开档位

- **WHEN** `SERVICE_OBO=off` 且请求带 actor 头
- **THEN** 拒绝，错误码为 `obo_disabled`；同一请求补足 actor 头也不改变该结论（原因不在调用方）

#### Scenario: actor 未登记

- **WHEN** actor 头指向从未在连接器登录过的身份
- **THEN** 拒绝，错误码为 `actor_unregistered`，且诊断路径不创建该身份

#### Scenario: actor 已停用

- **WHEN** actor 头指向已被停用的身份
- **THEN** 拒绝，错误码为 `actor_disabled`，与 `actor_unregistered` 可区分

#### Scenario: consent 档缺同意行

- **WHEN** `SERVICE_OBO=consent` 且无该（服务令牌, actor 租户）consent 行
- **THEN** 拒绝，错误码为 `consent_missing`

#### Scenario: 未启用租户模式

- **WHEN** `TENANCY=off` 时请求诊断端点
- **THEN** 回答 404 `tenancy_disabled`（与其余租户路由一致），不泄漏任何身份信息
