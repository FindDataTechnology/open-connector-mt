## MODIFIED Requirements

### Requirement: 用户 PAT

面板可铸造/撤销绑定唯一租户的 `user_pat`；令牌明文仅铸造时展示一次，库中只存哈希；撤销即时生效。

铸造 SHALL 可携带**范围**（scope），由三种白名单表达：动作白名单 `allowedActions`（规则形如 `service.action`、支持通配）、操作类白名单 `allowedOperations`（`{provider, operationType}` 元组，operationType ∈ `read`/`write`/`destructive`）、连接白名单 `allowedConnections`（本租户连接 id）。三个白名单在铸造时校验——动作规则 MUST 命中目录中至少一个动作、操作类 MUST 在目录中存在至少一个该类动作、连接 id MUST 是本租户现存连接；任一不满足 SHALL 返回 400 且不产生令牌。三者缺省为空，空白的既有语义不变（**空 allowlist = 不限制**，即今日的全权 PAT）。

`allowedActions` 与 `allowedOperations` SHALL 取并集：动作命中任一白名单即视为已授权；只要二者之一非空，该令牌即受范围约束。操作类 MUST 以元组存储与执行，MUST NOT 展开成动作 id 列表——`service.*` 无法表达「只读」（会同时授予 write/destructive），而展开 id 会撞上 128 条规则上限并在目录新增动作后静默失效。

范围 PAT 的授权面 SHALL 是既有策略层的交集：它只能收紧，MUST NOT 放宽部署级动作策略、连接归属校验或 admin 域权限。以范围 PAT 调用 `list_connections` SHALL 只返回其连接白名单内的连接。

令牌记录 SHALL 携带归属标签 `purpose`（自由文本，供调用方标注该令牌服务的绑定/代理，如同一身份多枚 PAT 时区分来源），列表接口 SHALL 返回该标签。

同一身份下以**同名**再次铸造 SHALL 把新范围并入既有范围（并集）、吊销旧令牌、返回新令牌；范围因此只增不减，收窄只能通过撤销后新铸达成。这使消费侧可按绑定幂等重铸而不会累积令牌。

`TENANCY=off` 下同一铸造/范围语义 SHALL 同样可用，租户退化为引导租户 `local-admin`。

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

#### Scenario: 空白范围向后兼容

- **WHEN** 调用方以不带 `allowedActions` / `allowedConnections` 的请求铸造 PAT
- **THEN** 令牌照旧铸造成功，其可执行面与本次变更前一致（该租户全部连接 × 目录全部动作）

#### Scenario: 操作类范围只读不改写

- **WHEN** 以 `allowedOperations=[{provider:"kingdee", operationType:"read"}]` 铸造的 PAT 执行 `kingdee.create_bill`（write）
- **THEN** 拒绝，错误码为 `action_not_allowed`；执行 `kingdee.list_bills` 则通过，`checks` 中的命中规则形如 `kingdee@read`

#### Scenario: 操作类与动作规则取并集

- **WHEN** 以 `allowedActions=["feishu.*"]` 与 `allowedOperations=[{provider:"kingdee",operationType:"read"}]` 铸造的 PAT
- **THEN** `feishu.*` 与 kingdee 的 read 类动作都通过，kingdee 的 write 类动作拒绝

#### Scenario: 目录无法满足的操作类当场拒收

- **WHEN** 铸造请求的 `allowedOperations` 指向不存在的 provider，或该 provider 没有该类动作（如只读 provider 的 `write`）
- **THEN** 返回 400 `invalid_scope`，不产生令牌

#### Scenario: 范围 PAT 收紧动作面

- **WHEN** 以 `allowedActions = ["kingdee.*"]` 铸造的 PAT 执行 `feishu.create_doc`
- **THEN** 拒绝，错误码为 `action_not_allowed`；执行 `kingdee.list_bills` 则通过

#### Scenario: 范围只收紧不放宽

- **WHEN** 部署级策略屏蔽了某动作，而范围 PAT 的 `allowedActions` 命中该动作
- **THEN** 仍拒绝（部署级策略在上）；范围 PAT 不能越过部署级管控

#### Scenario: 连接白名单过滤列表

- **WHEN** 范围 PAT（`allowedConnections` 只含一个连接 id）调用 `list_connections`
- **THEN** 结果只含该连接，其他同租户连接不出现

#### Scenario: 非法范围当场拒收

- **WHEN** 铸造请求的 `allowedActions` 含目录中不存在的规则，或 `allowedConnections` 含他租户/不存在的连接 id
- **THEN** 返回 400，不产生令牌，也不影响既有令牌

#### Scenario: 同名重铸取并集并吊销旧令牌

- **WHEN** 同一身份以同名 `name` 再次铸造，新范围包含旧范围之外的动作
- **THEN** 新令牌同时具备新旧范围，旧令牌立即失效（401），列表中该名字仍只有一枚有效令牌

#### Scenario: 归属标签可读

- **WHEN** 用户列出本租户的 PAT
- **THEN** 每项含名称、归属标签 `purpose` 与最近使用时间（不含明文）

#### Scenario: off 档同样可铸范围 PAT

- **WHEN** `TENANCY=off` 时铸造带范围的 PAT
- **THEN** 铸造成功，令牌归属于引导租户 `local-admin`，范围语义与 oidc 档一致

### Requirement: TENANCY 开关语义

`TENANCY` 决定认证路径：`off`（默认）走上游既有 admin/runtime token 路径，`oidc` 启用租户认证路径。两档下的上游既有凭证（admin token、`kind='runtime'` 令牌）语义不变。

范围 PAT 的铸造与执行语义 SHALL 在两档下一致：`off` 档退化为引导租户 `local-admin`，不因缺少租户层而跳过范围校验；`oidc` 档按身份所属租户校验连接白名单。

#### Scenario: off 档行为不变

- **WHEN** `TENANCY=off` 时以 admin token 或 runtime token 请求
- **THEN** 认证与授权行为与上游一致，OIDC/PAT 路径不可达

#### Scenario: oidc 档未配置 OIDC 拒启

- **WHEN** `TENANCY=oidc` 但 OIDC issuer/JWKS 配置缺失时启动
- **THEN** 进程以明确错误退出（fail-fast），不落入无认证的开放状态

#### Scenario: off 档的范围校验不放水

- **WHEN** `TENANCY=off` 下以范围 PAT 执行白名单外的动作
- **THEN** 与 oidc 档同样拒绝（`action_not_allowed`），不因引导租户而全放行

## ADDED Requirements

### Requirement: PAT 递归收窄铸造（attenuation）

铸造端点 SHALL 同时接受 `user_pat` 作为鉴权载体（除既有 OIDC 会话外），使无浏览器会话的调用方（桌面端、后台服务）也能为自身派生带范围的子令牌。

子令牌 SHALL 满足**衰减**约束：请求范围 MUST 是调用令牌自身范围的子集（未设范围的父令牌视为全集）；超出部分 SHALL 被拒（403），不得静默裁剪。子令牌 SHALL 归属父令牌同一租户，`purpose` 必须由调用方给出以便审计回溯到派生者。

该路径 MUST NOT 成为提权通道：子令牌既不能超出父令牌范围，也不能获得父令牌没有的权限（admin 域、OBO、管理面）。父令牌撤销时，其派生的子令牌 SHALL 一并失效。

#### Scenario: 父令牌派生子令牌

- **WHEN** 以范围 PAT（`allowedActions=["kingdee.*"]`）为鉴权调用铸造端点，请求 `allowedActions=["kingdee.list_bills"]`
- **THEN** 铸造成功，子令牌只能执行 `kingdee.list_bills`

#### Scenario: 操作类范围同样受衰减约束

- **WHEN** 以 `allowedOperations=[{provider:"kingdee",operationType:"read"}]` 的 PAT 为鉴权，请求 `allowedOperations=[{provider:"kingdee",operationType:"write"}]` 或 `allowedActions=["kingdee.*"]`
- **THEN** 返回 403 `scope_not_attenuated`；请求 `allowedActions=["kingdee.list_bills"]`（该类中的单个动作）则通过

#### Scenario: 父范围可跨形态传递

- **WHEN** 父令牌仅有动作规则 `kingdee.*`，子令牌请求 `(kingdee, read)`；或父令牌仅有 `(kingdee, read)`，子令牌未声明任何动作/操作类范围
- **THEN** 前者通过（`provider.*` 覆盖该 provider 的所有类），后者继承父令牌的 `(kingdee, read)` 而不放大

#### Scenario: 超出父范围被拒

- **WHEN** 以 Range PAT 为鉴权请求包含父范围之外动作的子令牌
- **THEN** 返回 403，不产生令牌，也不静默裁剪成可用子集

#### Scenario: 全权父令牌可派生任意子集

- **WHEN** 以未设范围的全权 PAT 为鉴权铸造任意合法的范围子令牌
- **THEN** 铸造成功；这是消费侧把既有全权凭证逐步替换为范围凭证的迁移路径

#### Scenario: 父撤销连带子失效

- **WHEN** 父令牌被撤销后，其派生的子令牌再次请求运行面
- **THEN** 拒绝（401），无需逐枚手工撤销

#### Scenario: 不能提权

- **WHEN** 以 user_pat 派生令牌并尝试用它访问 admin 域或发起 OBO 代调
- **THEN** 拒绝，衰减路径不引入任何父令牌不具备的权限
