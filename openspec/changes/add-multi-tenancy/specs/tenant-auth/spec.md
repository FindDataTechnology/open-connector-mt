# tenant-auth Specification

## Purpose

多租户模式的认证与令牌体系：OIDC 浏览器会话、每用户 PAT、服务主体 PAT 与代调（OBO）及 consent 三档，外加 `TENANCY` 开关语义与 admin token 的保留地位。

## ADDED Requirements

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
