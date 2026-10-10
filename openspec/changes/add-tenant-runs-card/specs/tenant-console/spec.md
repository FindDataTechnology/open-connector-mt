# tenant-console Delta — add-tenant-runs-card

## ADDED Requirements

### Requirement: 用户面板运行记录

`TENANCY=oidc` 下用户面板提供本租户的最近运行记录：只读路由 `GET /api/tenant/runs` 按 `runWithTenant` 租户限定返回该租户名下一切调用（含 service PAT 的 OBO 代调）最近 20 条（不分页）；响应为投影字段（时间/耗时/成败/actionId/caller/连接名/errorCode/errorMessage/inputSummary/outputSummary 与 PAT 名映射），不回传 runtimeTokenId、tenantId、policy 明细。`/me` 面板以运行记录卡呈现：默认收起、标题带条目计数、手动刷新（不轮询）、置于试跑卡之后。

#### Scenario: 最近调用列表

- **WHEN** 已登录租户展开运行记录卡
- **THEN** 呈现本租户最近 20 条调用（时间+耗时、成败、actionId、caller、连接名、发起 PAT 名），最近优先

#### Scenario: 投影剔除内部标识

- **WHEN** 运行记录数据返回租户侧
- **THEN** 不含 runtimeTokenId、tenantId、policy 检查明细；发起方以 PAT 名展示（OBO 代调的发起令牌属服务方、已删除令牌等无匹配场景统一回退中性占位文案，不区分原因）

#### Scenario: 脱敏摘要可展开

- **WHEN** 租户点击某条调用的输入/输出摘要
- **THEN** 展示服务端已脱敏的 inputSummary/outputSummary（敏感值呈 `[redacted]`），不发起额外请求

#### Scenario: 含 OBO 代调

- **WHEN** service PAT 以 actor 身份代本租户发起调用（OBO）
- **THEN** 该条目出现在本租户运行记录中（落库 tenant_id 即本租户）

#### Scenario: 租户隔离

- **WHEN** A 租户请求 `/api/tenant/runs`
- **THEN** 结果不含 B 租户的任何调用

#### Scenario: 默认收起与手动刷新

- **WHEN** 用户面板呈现
- **THEN** 运行记录卡位于试跑卡之后、默认收起、标题带条目计数；展开与刷新均由用户手动触发，无自动轮询

#### Scenario: off 档无此能力

- **WHEN** `TENANCY=off`
- **THEN** 不存在 `/api/tenant/runs` 路由与运行记录卡（本需求全部行为仅限 `TENANCY=oidc`）
