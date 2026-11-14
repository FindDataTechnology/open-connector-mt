# tenant-auth Specification

## Purpose

定义 `TENANCY=oidc` 部署下的身份与授权模型：用户 PAT 与 OIDC 会话代表"某个人"，服务
PAT 代表"某个受信服务"，后者只有在声明了 actor 时才变成"代谁执行"；`SERVICE_OBO` 三档
决定代调是否被允许、以及是否还需要 per-tenant consent。admin token 在两档下都保留跨
租户的全权视图，是唯一不受租户边界约束的凭证。`TENANCY=off` 时整套租户语义不加载，
上游行为逐字节不变——这是本规格所有条款的前提。

服务身份的失败必须**可区分**：`actor_header_missing`、`obo_disabled`、
`actor_unregistered`、`actor_disabled`、`consent_missing` 各由一个不同的人修复，
因此 `GET /api/tenant/service-whoami` 只读地回答"能不能、不能是为什么"，且与授权
路径共用同一实现。

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

### Requirement: OIDC 浏览器会话

console 用户面板 SHALL 以 OIDC 公共客户端（PKCE）登录；授权码交换 SHALL 经服务端代理完成；验签 SHALL 校验签名、issuer、audience 与时效。

#### Scenario: 正常登录

- **WHEN** 用户经 OIDC 完成登录回调
- **THEN** 建立会话，后续面板请求以该身份的租户执行

#### Scenario: 验签失败拒绝

- **WHEN** ID token 签名无效、issuer 不匹配、audience 不符或已过期
- **THEN** 拒绝建立会话，返回明确错误，不创建身份

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

### Requirement: admin token 保留

admin token SHALL 在两档下均保留：可访问运维端点，并在 MT 模式下具有跨租户视图与操作权（文档明示的全权凭证）。

#### Scenario: admin 跨租户运维

- **WHEN** MT 模式下以 admin token 请求管理端点
- **THEN** 可跨租户操作（含身份停用、consent 行管理），操作计入运行/审计记录

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
