# tenant-auth Specification

## Purpose
TBD - created by archiving change add-service-pat-issuance. Update Purpose after archive.

## Requirements

### Requirement: 服务主体 PAT 的发放与撤销

`service_pat` SHALL 只能由 admin 域铸造：铸造请求 SHALL 可指定 `kind: "service_pat"`，铸造出的令牌 SHALL 不带 `tenant_id`，明文 SHALL 仅在铸造响应中出现一次，且 SHALL 出现在运行时令牌列表（带 kind 标识）并可被撤销；撤销 SHALL 同步终结指向该令牌的全部 consent 行。请求中出现的其他 kind 值 SHALL 被拒绝（400），因为 `user_pat` 必须绑定身份、只能经 OIDC 会话路径铸造。`TENANCY=off` 下未指定 kind 的铸造行为 SHALL 与上游一致。

#### Scenario: admin 铸造 service_pat

- **WHEN** admin 域以 `kind: "service_pat"` 铸造令牌
- **THEN** 响应含一次性明文与 kind 标识，库中该令牌 tenant_id 为空
- **AND** 该令牌出现在运行时令牌列表中

#### Scenario: service_pat 可撤销且即时生效

- **WHEN** admin 撤销某 service_pat 后它以 actor 头再次请求
- **THEN** 拒绝（401），与 user_pat 撤销同形

#### Scenario: admin 撤销终结全部 consent 行

- **WHEN** admin 撤销某 service_pat，且存在租户对它的 consent 行
- **THEN** 这些 consent 行随撤销一并终结，consent 查询不再命中

#### Scenario: 非法 kind 被拒

- **WHEN** 铸造请求指定 `kind: "user_pat"` 或任何其他值
- **THEN** 返回 400，不产生任何令牌
- **AND** 错误说明只支持 service_pat（user_pat 需经 OIDC 会话路径）

#### Scenario: 未指定 kind 的铸造在 off 档不变

- **WHEN** `TENANCY=off` 且铸造请求未指定 kind
- **THEN** 产出的令牌与上游一致（legacy runtime token），行为无差异

#### Scenario: service_pat 无管理面权限

- **WHEN** 以 service_pat（无论是否携带 actor 头）请求 admin 域端点
- **THEN** 拒绝（403），admin 域仍仅 admin token 可达

#### Scenario: 代调以 actor 租户执行并落审计

- **WHEN** 有效 service_pat 携带已登记身份的 actor 头执行动作，且 `SERVICE_OBO=allow-all`
- **THEN** 以该 actor 租户解析连接并执行
- **AND** 运行记录同时落 service 与 actor 身份以备审计

#### Scenario: actor 头缺失或未登记时拒绝

- **WHEN** service_pat 未携带 actor 头，或 actor 指向不存在/已停用的身份
- **THEN** 拒绝，不自动创建身份

### Requirement: TENANCY 开关语义

`TENANCY` 决定认证路径：`off`（默认）走上游既有 admin/runtime token 路径，`oidc` 启用租户认证路径。两档下的上游既有凭证（admin token、`kind='runtime'` 令牌）语义不变。

#### Scenario: off 档行为不变

- **WHEN** `TENANCY=off` 时以 admin token 或 runtime token 请求
- **THEN** 认证与授权行为与上游一致，OIDC/PAT 路径不可达

#### Scenario: oidc 档未配置 OIDC 拒启

- **WHEN** `TENANCY=oidc` 但 OIDC issuer/JWKS 配置缺失时启动
- **THEN** 进程以明确错误退出（fail-fast），不落入无认证的开放状态

### Requirement: OIDC 浏览器会话

console 用户面板以 OIDC 公共客户端（PKCE）登录；授权码交换经服务端代理完成；验签校验签名、issuer、audience 与时效。

#### Scenario: 正常登录

- **WHEN** 用户经 OIDC 完成登录回调
- **THEN** 建立会话，后续面板请求以该身份的租户执行

#### Scenario: 验签失败拒绝

- **WHEN** ID token 签名无效、issuer 不匹配、audience 不符或已过期
- **THEN** 拒绝建立会话，返回明确错误，不创建身份

### Requirement: 用户 PAT

面板可铸造/撤销绑定唯一租户的 `user_pat`；令牌明文仅铸造时展示一次，库中只存哈希；撤销即时生效。

#### Scenario: 铸造与一次性展示

- **WHEN** 用户在面板铸造 PAT
- **THEN** 明文仅出现在本次响应中，此后任何接口不可再取回

#### Scenario: PAT 租户绑定

- **WHEN** 以 user_pat 调用运行面（/v1、/mcp）
- **THEN** 全部以该 PAT 所属租户执行，无法指定其他租户

#### Scenario: PAT 无管理面权限

- **WHEN** 以 user_pat 请求 admin 域端点（连接管理、运行时令牌管理等）
- **THEN** 拒绝（403），admin 域仍仅 admin token 可达

#### Scenario: 撤销即时生效

- **WHEN** 用户撤销某 PAT 后该 PAT 再次请求
- **THEN** 拒绝（401），已在途的后续请求同样拒绝

### Requirement: 服务主体代调（OBO）

`service_pat` 不属于任何用户租户；凭 `x-oo-connector-actor-sub` 头以指定身份的租户执行。`SERVICE_OBO` 三档管辖：`off`（默认）禁用、`allow-all` 全放行、`consent` 需 consent 行。

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

### Requirement: admin token 保留

admin token 在两档下均保留：可访问运维端点并在 MT 模式下具有跨租户视图与操作权（文档明示的全权凭证）。

#### Scenario: admin 跨租户运维

- **WHEN** MT 模式下以 admin token 请求管理端点
- **THEN** 可跨租户操作（含身份停用、consent 行管理），操作计入运行/审计记录
