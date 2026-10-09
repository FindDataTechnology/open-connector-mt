## ADDED Requirements

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
