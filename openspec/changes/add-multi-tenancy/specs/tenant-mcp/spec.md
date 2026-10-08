# tenant-mcp Specification

## Purpose

MCP 端点（上游 5 工具面）在多租户模式下的可见性与执行归属校验；`TENANCY=off` 下与上游行为一致。

## ADDED Requirements

### Requirement: 连接可见性按租户过滤

MT 模式下 `list_connections` 仅返回调用方租户（PAT 所属租户，或 OBO 场景下 actor 租户）的连接。

#### Scenario: 只见本租户
- **WHEN** user_pat 会话调用 `list_connections` 而实例中存在多租户连接
- **THEN** 结果仅含该租户的连接

#### Scenario: off 档不变
- **WHEN** `TENANCY=off` 下调用 `list_connections`
- **THEN** 返回全部连接，与上游一致

### Requirement: 执行归属校验

`execute_action` 的连接解析以调用方租户为界：租户内连接正常执行并代入凭证；他租户连接返回与"不存在"同形的错误。

#### Scenario: 本租户执行
- **WHEN** 调用方指定自己租户内某连接执行动作
- **THEN** 动作以该连接凭证执行，结果与上游语义一致

#### Scenario: 越界不可探测
- **WHEN** 调用方指定的 `(provider, connectionName)` 仅存在于其他租户
- **THEN** 返回 `connection_not_found`，与真正不存在无法区分

#### Scenario: 策略与授权叠加
- **WHEN** 连接归属校验通过但 runtime policy 或令牌 grant 拒绝该动作
- **THEN** 按上游策略语义拒绝；租户校验不放宽既有策略

### Requirement: 目录工具保持全局

`list_apps`、`search_actions`、`get_action_guide` 返回全局 provider 目录，不做租户过滤（目录是公共资产）。

#### Scenario: 目录全量可见
- **WHEN** 任意租户的令牌调用目录三工具
- **THEN** 结果与上游一致（同一目录、同一 guide 原文，不翻译）
