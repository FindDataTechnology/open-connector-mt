## ADDED Requirements

### Requirement: 目录读面由部署配置决定是否存在

平台 SHALL 只在部署显式启用时注册 `/api/catalog/*` 路由。默认（未配置）SHALL NOT 注册任何该前缀的路由，请求该前缀 SHALL 得到框架的 404；既有的 `/v1/*`、`/api/*`、`/api/tenant/*` 与 `/mcp` 的鉴权语义 SHALL NOT 因本面存在或不存在而改变。

启用形态 SHALL 为两种互斥模式之一：`public`（匿名可读）与 `service`（需要专用令牌）。无法识别的取值 SHALL 使部署启动失败并指明允许取值，MUST NOT 静默降级成 `public`——把「配错了」变成「对全世界开放」是这条约束唯一防的事。

该要求 SHALL 在 `TENANCY=off` 与 `TENANCY=oidc` 两种模式下同样成立：本面不读租户，故两种模式行为一致。

#### Scenario: 未启用时前缀不存在

- **WHEN** 部署未设置目录读面开关，请求 `GET /api/catalog/providers`
- **THEN** 响应为 404，且不泄露该面存在的信息
- **AND** 既有 `/api/tenant/*`、`/v1/*`、`/mcp` 的行为与启用前逐字节一致

#### Scenario: 取值非法时启动失败

- **WHEN** 开关被设成 `public`/`service` 之外的值
- **THEN** 进程启动失败并指出允许取值，不注册该面

#### Scenario: 两种租户模式行为一致

- **WHEN** 分别以 `TENANCY=off` 与 `TENANCY=oidc` 启用 `service` 模式并携带正确令牌请求目录
- **THEN** 两次返回的 provider 与覆盖度内容逐字段相等

### Requirement: 模式门：匿名与专用令牌

`public` 模式下本面 SHALL 接受无凭据请求。

`service` 模式下本面 SHALL 要求 `Authorization: Bearer <专用令牌>`，且该令牌 SHALL 独立于部署的 admin 令牌与 runtime 令牌：admin 令牌与 runtime 令牌在本面 MUST NOT 因此获得任何额外能力，专用令牌在本面之外 MUST NOT 获得任何能力。比较 SHALL 为常量时间比较。

缺失凭据与错误凭据 SHALL 都返回 401 并带上一个机器可读的错误码；SHALL NOT 返回 404（那会让「被门挡」与「没有这个面」混淆，是排查时最常见的误判方向）。

专用令牌未配置而模式为 `service` 时，部署 SHALL 在启动期失败，MUST NOT 以「空令牌恒不匹配」的方式静默拒绝所有请求。

#### Scenario: public 模式匿名可读

- **WHEN** 模式为 `public`，匿名请求 provider 列表
- **THEN** 返回 200 与目录内容

#### Scenario: service 模式缺令牌被门挡

- **WHEN** 模式为 `service`，请求未带 Authorization
- **THEN** 返回 401 与机器可读错误码，MUST NOT 返回 404

#### Scenario: service 模式错令牌被门挡

- **WHEN** 模式为 `service`，携带 admin 令牌或 runtime 令牌请求本面
- **THEN** 返回 401：这两枚令牌不覆盖本面

#### Scenario: service 模式未配令牌时启动失败

- **WHEN** 模式为 `service` 而专用令牌为空
- **THEN** 进程启动失败并指明缺少该令牌

### Requirement: 只读、无副作用

本面的每个端点 SHALL 只读：MUST NOT 执行任何 provider 动作、MUST NOT 写入 run 记录、MUST NOT 铸造或吊销任何令牌、MUST NOT 修改连接或策略。

端点集合 SHALL 限于：provider 列举、单 provider 详情、按 `(provider, operationType)` 的覆盖度、单 action 的归属与类。任何写动词（POST/PUT/PATCH/DELETE）在本前缀 SHALL 返回 405。

#### Scenario: 只读面不产生运行记录

- **WHEN** 通过本面读取某 action 的元数据
- **THEN** 该租户与平台都不新增 run 记录
- **AND** 既有令牌集合逐字段不变

#### Scenario: 写动词被拒

- **WHEN** 对本面前缀发起 POST/PUT/PATCH/DELETE
- **THEN** 返回 405

### Requirement: 绝不返回租户事实

本面返回体 SHALL NOT 包含、也不得以任何嵌套形式包含：连接（含连接 id、名称、是否已配置、是否虚拟）、租户或身份标识、用户、PAT（含 id、名称、范围、铸造或失效信息）、run 记录（含入参出参摘要）、OAuth 客户端配置、私有来源或多实例配置、任何凭证原文或其片段。

本面返回的每个字段 SHALL 能追溯到目录数据本身（provider 元数据、action 元数据、以及由此计算出的覆盖度）。新增字段前 SHALL 先回答「它是不是目录事实」，非目录事实一律不进本面。

#### Scenario: 返回体只含目录事实

- **WHEN** 请求 provider 详情与覆盖度
- **THEN** 响应字段集合全部为目录元数据
- **AND** 不含任何连接、租户、PAT、run 或凭证字段（含嵌套）

#### Scenario: 同一个 provider 对不同调用者返回相同内容

- **WHEN** 两个不同身份的调用者请求同一 provider 的覆盖度
- **THEN** 两次响应逐字段相等——本面没有「我的」与「你的」之分

### Requirement: 覆盖度与租户面同口径

本面的覆盖度 SHALL 与 `/api/tenant/catalog-coverage` 对同一 `(provider, operationType)` 给出相同的 `covered`、`actionCount`、`executableActionCount` 与 `gaps`。两者 MUST NOT 各自维护一套「什么算覆盖」的判定——本面 SHALL 复用同一计算，不得复制一份近似实现。

`actionCount` SHALL 为目录中该 provider 该类动作的总数；`executableActionCount` SHALL 为其中 `locallyExecutable` 为真的数量；`covered` SHALL 等价于 `executableActionCount > 0`。

#### Scenario: 两个面给出同一答案

- **WHEN** 对同一 provider 与同一组操作类分别请求本面与 `/api/tenant/catalog-coverage`
- **THEN** `covered`、`actionCount`、`executableActionCount`、`gaps` 逐字段相等

#### Scenario: 未知 provider 的可区分回答

- **WHEN** 请求目录中不存在的 provider
- **THEN** 返回 404 与 `unknown_provider` 错误码
- **AND** MUST NOT 返回「覆盖度为 0」——「没有这个系统」与「有这个系统但没动作」是两件事
