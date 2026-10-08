# multi-tenancy Specification

## Purpose

租户模型与存储隔离：每个用户身份拥有一个租户，其连接、OAuth 状态与令牌在数据层按租户隔离；`TENANCY=off` 时与上游单租户行为字节级兼容。

## ADDED Requirements

### Requirement: 租户归属唯一

每条连接、OAuth 状态、用户 PAT 必须属于恰好一个租户；同一 provider 下不同租户可以使用相同的连接名而互不覆盖。

#### Scenario: 同名连接跨租户共存
- **WHEN** 租户 A 与租户 B 各自创建 provider `github` 下名为 `default` 的连接
- **THEN** 两条记录独立存在，任一租户的写入不覆盖另一租户的记录

#### Scenario: 连接名在租户内仍唯一
- **WHEN** 同一租户对同一 provider 重复创建同名连接
- **THEN** 行为与上游一致：upsert 覆盖更新

### Requirement: 引导租户兼容层

`TENANCY=off`（默认）下系统表现为上游单租户：全部读写落在引导租户 `local-admin`，租户维度不向任何 API、MCP 工具或 console 面暴露。

#### Scenario: 存量数据迁移归属
- **WHEN** 一个上游部署升级到本 fork（执行 0018 迁移）且保持 `TENANCY=off`
- **THEN** 既有 connections/oauth_states/runtime_tokens 行全部归属引导租户，既有 admin token、runtime token、console 与 MCP 行为与升级前一致

#### Scenario: 单租户模式无租户面
- **WHEN** `TENANCY=off` 时访问 console 或 MCP
- **THEN** 不出现用户登录、PAT 或任何租户相关入口

### Requirement: 身份首见登记

多租户模式下，首次验签通过的 OIDC `(issuer, subject)` 自动创建身份及其用户租户；此后同一身份复用同一租户。身份无密码、无本地登录面。

#### Scenario: 首次登录建租户
- **WHEN** 一个新的 `(issuer, subject)` 通过 OIDC 验签
- **THEN** 创建对应 identity 与 `kind='user'` 租户，后续请求归属该租户

#### Scenario: 重复登录复用
- **WHEN** 同一 `(issuer, subject)` 再次登录
- **THEN** 不产生新租户，归属不变

#### Scenario: 停用的身份拒绝
- **WHEN** `disabled_at` 非空的身份持有效令牌请求
- **THEN** 请求被拒绝（401/403），其名下 PAT 同时失效

### Requirement: 租户数据隔离不变量

任何租户视角的 API 响应、MCP 工具结果或 console 页面不得包含其他租户的连接数据（含凭证元数据与存在性）。

#### Scenario: 跨租户不可探测
- **WHEN** 租户 A 的令牌查询、列举或执行仅存在于租户 B 的连接（含同名猜测）
- **THEN** 一律得到与"连接不存在"完全同形的结果，不泄漏存在性

### Requirement: 身份删除级联

删除一个身份时，其名下租户的连接、OAuth 状态与用户 PAT 级联删除（数据销毁权）。

#### Scenario: 删除身份清空足迹
- **WHEN** 管理操作删除一个 identity
- **THEN** 该租户的连接与 PAT 不复存在，此后任何令牌对其资源的访问得到"不存在"结果
