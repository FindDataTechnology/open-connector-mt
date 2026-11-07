# tenant-mcp Specification

## Purpose
MCP 端点（上游 5 工具面）在多租户模式下的可见性与执行归属校验；`TENANCY=off` 下与上游行为一致。

## Requirements

### Requirement: 连接可见性按租户过滤

MT 模式下 `list_connections` 仅返回调用方租户（PAT 所属租户，或 OBO 场景下 actor 租户）的连接；若该令牌带连接白名单，结果 SHALL 再按白名单收窄（交集），不再返回白名单外的同租户连接。

#### Scenario: 只见本租户

- **WHEN** user_pat 会话调用 `list_connections` 而实例中存在多租户连接
- **THEN** 结果仅含该租户的连接

#### Scenario: off 档不变

- **WHEN** `TENANCY=off` 下调用 `list_connections`
- **THEN** 返回全部连接，与上游一致

#### Scenario: 白名单内才可见

- **WHEN** 带连接白名单的 user_pat 会话调用 `list_connections`
- **THEN** 结果只含白名单内的连接，白名单外的同租户连接不出现

#### Scenario: 空白名单不额外收窄

- **WHEN** 令牌未设置连接白名单
- **THEN** 按租户过滤后的集合原样返回，不额外收窄

### Requirement: 执行归属校验

`execute_action` 的连接解析以调用方租户为界：租户内连接正常执行并代入凭证；他租户连接返回与"不存在"同形的错误。

此外，因**范围不足**被拒（令牌动作白名单未命中，或所解析连接不在令牌连接白名单内）时，调用方 SHALL 能取得结构化范围信息以判断「该申请什么」：被拒动作的 `provider`、其 `operationType`、以及拒绝来源（哪一层策略未命中）。该信息 SHALL 可随拒绝结果返回，或经同一令牌可读的查询面按动作 id 取得——两种形态择一，但 MUST 对调用方等价可得。人类可读 message 与既有错误码 MUST 保持不变（向后兼容），且不得泄露其他租户或白名单外的任何连接存在性。

#### Scenario: 本租户执行

- **WHEN** 调用方指定自己租户内某连接执行动作
- **THEN** 动作以该连接凭证执行，结果与上游语义一致

#### Scenario: 越界不可探测

- **WHEN** 调用方指定的 `(provider, connectionName)` 仅存在于其他租户
- **THEN** 返回 `connection_not_found`，与真正不存在无法区分

#### Scenario: 策略与授权叠加

- **WHEN** 连接归属校验通过但 runtime policy 或令牌 grant 拒绝该动作
- **THEN** 按上游策略语义拒绝；租户校验不放宽既有策略

#### Scenario: 范围不足可申请

- **WHEN** 范围 PAT 执行白名单外的动作被拒
- **THEN** 结果为 `action_not_allowed`，且调用方可取得该动作的 `provider` 与 `operationType`，据此渲染「申请该 provider 该类操作」的授权入口

#### Scenario: 连接不在白名单

- **WHEN** 范围 PAT 指定白名单外的同租户连接执行动作
- **THEN** 结果为 `connection_not_allowed`，且不透露该连接名称、归属或是否存在

#### Scenario: 拒绝不改写人读文本

- **WHEN** 对比本次变更前后同一次范围不足的拒绝
- **THEN** 人类可读 message 与错误码保持不变，仅新增结构化字段

### Requirement: 目录工具保持全局

`list_apps`、`search_actions`、`get_action_guide` 返回全局 provider 目录，不做租户过滤（目录是公共资产）。

#### Scenario: 目录全量可见

- **WHEN** 任意租户的令牌调用目录三工具
- **THEN** 结果与上游一致（同一目录、同一 guide 原文，不翻译）
