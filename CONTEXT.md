# open-connector-mt

oomol-lab/open-connector 的多租户开源分支：一个自托管连接网关，让每个用户在自己的租户里存储和管理到外部 SaaS 的连接凭证，agent 经 MCP/HTTP 在凭证不出库的前提下调用其上的动作。萬星（constellation 线）连接器的载体。

## Language

**租户（tenant）**:
连接与授权的归属容器。v1 中一个租户对应一个用户身份；组织租户预留（tenants.kind 扩展）。
_Avoid_: 账户空间、workspace、组织（v1 尚无此层级时）

**引导租户（bootstrap tenant）**:
`TENANCY=off`（默认）下的唯一租户，id 固定为 `local-admin`——上游单租户行为的兼容层，所有未标租户的存量行归它。
_Avoid_: 默认租户、系统租户

**身份（identity）**:
来自 OIDC `(issuer, subject)` 的登录身份，首见登记进 identities 表，归属于恰好一个租户。无密码、无本地登录面。
_Avoid_: 用户表、账号

**用户 PAT（user_pat）**:
本服务铸造的每用户令牌（`oct_` 前缀，SHA-256 落库，可软撤销），供 agent/MCP 面使用，绑定唯一租户。
_Avoid_: API key（那是连接里的凭证概念）、runtime token（上游 kind=runtime 的旧称，仅限历史语境）

**服务主体（service_pat）**:
平台级服务令牌：不属于任何用户租户，代表一个可信服务（如谦面 facet agent 服务）。
_Avoid_: 机器账号、bot token

**代调（on-behalf-of / OBO）**:
服务主体凭 `x-oo-connector-actor-sub` 头指定终端用户租户并以该租户执行；consent 三档（off/allow-all/consent）管辖。
_Avoid_: 模拟（impersonate，暗示无审计的伪造）

**同意（consent）**:
某租户对某服务主体代调的授权记录。v1 允许全放行起步，翻到强制档只改 env 不改表。
_Avoid_: 授权（歧义——OAuth 授权流另有其词）

**连接（connection）**:
`(租户, provider, 连接名)` 唯一的凭证记录；凭证原文（API key/OAuth token 等）加密落库、永不出库。
_Avoid_: 集成、integration

**平台级 OAuth app（platform OAuth app）**:
注册在 `platform` 租户下的 provider OAuth 客户端配置，全体租户可用；租户级覆盖行仅预留。
_Avoid_: 全局 app（跨租户共享的是配置不是连接）

**动作（action）**:
provider 目录中预定义的一次可执行调用（10000+ 个），执行时代入连接凭证。目录归上游，本 fork 不改不译。
_Avoid_: 工具（tool 仅指 MCP 面的 5 个元工具）
