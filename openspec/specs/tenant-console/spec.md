# tenant-console Specification

## Purpose
console 的用户面板（独立壳层 + 连接全生命周期 + PAT 管理）与 zh-CN/en 双语机制；`TENANCY=off` 下 console 保持上游 admin 面孔。

## Requirements

### Requirement: 用户面板独立壳层

`TENANCY=oidc` 下 `/me` 用户面板使用独立于管理台的壳层版式与品牌：顶部通栏品牌条 + 纵向主区，不借用管理台的两列网格布局；品牌为「萬星连接器 / Wanxing Connector」，管理台品牌保持上游原文。用户面板顶栏默认不提供指向管理台的入口（普通租户在 admin token 后会撞解锁墙）；仅当探测到既有 admin 会话（`GET /api/auth/session` 返回 `adminAuthConfigured && authenticated`）时显示「返回管理台」回程链接，点击走 SPA 内导航到 `/overview`（admin 会话 cookie 仍在，无需重新解锁）。「登录后落 `/me`」规则不变。

#### Scenario: 版式独立于管理台布局

- **WHEN** `TENANCY=oidc` 下打开 `/me`
- **THEN** 页面呈顶部通栏品牌条 + 主区的纵向版式，任何屏幕宽度下都不出现管理台侧栏列挤压头部元素的破碎排布

#### Scenario: 品牌正名

- **WHEN** 用户面板呈现品牌
- **THEN** 显示「萬星连接器 / Wanxing Connector」（随界面语言），不显示上游的「本地运行时控制台」
- **AND** 管理台（`TENANCY=off` 或直连 admin 面）的品牌文案不变

#### Scenario: 顶栏无管理入口

- **WHEN** 普通租户（admin 会话探测不为 `adminAuthConfigured && authenticated`）查看用户面板顶栏
- **THEN** 不存在指向 `/overview` 等管理台路由的链接，包括探测失败或未配置 admin token 的部署；直接访问管理台路由仍按既有 admin token 规则呈现解锁面

#### Scenario: 可证 admin 回程

- **WHEN** 曾解锁管理台的用户（浏览器持有 admin 会话 cookie）打开 `/me`，`/api/auth/session` 探测返回 `adminAuthConfigured && authenticated`
- **THEN** 顶栏出现「返回管理台」链接，点击后 SPA 内导航到 `/overview`，管理台呈已解锁状态（不要求重新输入 admin token）

#### Scenario: off 档不受影响

- **WHEN** `TENANCY=off` 下打开 console
- **THEN** 仅呈现上游 admin 视图，版式与品牌逐字节不变（本需求全部行为仅限 `TENANCY=oidc`）

### Requirement: 未登录引导页

`TENANCY=oidc` 下未登录用户打开 `/me`（含经根路径导流到达）时，系统 SHALL 呈现居中欢迎卡片：萬星连接器品牌 + 一句话产品定位 + 三步行引导（① 统一身份登录 ② 添加 SaaS 连接 ③ 铸造访问令牌并粘贴到壹座）+ 「了解产品」链接 + 一行安全承诺 + 唯一的登录入口按钮。SHALL 保持登录按钮为页面唯一登录入口。「了解产品」链接 SHALL 新标签打开官网产品介绍页，按界面语言选页（zh 系语言指中文页，其余语言指英文页）；定位与安全口径 SHALL 与官网介绍页同源（下限口径：1500+ 服务、万级预置动作；凭据加密托管、执行面不对公网）。本要求仅限 `TENANCY=oidc`。

#### Scenario: 居中引导卡

- **WHEN** 未登录用户打开 `/me`
- **THEN** 页面呈居中卡片，品牌、定位句、三步行、了解产品链接、安全承诺与登录按钮齐列，登录按钮为唯一登录入口

#### Scenario: 了解产品按语言选页

- **WHEN** 界面语言为 zh-CN / zh-TW
- **THEN** 「了解产品」链接指向官网产品介绍页中文版
- **WHEN** 界面语言为 en / ja / ru / fr
- **THEN** 链接指向官网产品介绍页英文版
- **AND** 均为新标签打开

#### Scenario: 登录后进入面板

- **WHEN** 用户点击登录并完成 OIDC 回流
- **THEN** 呈现已登录的用户面板（连接分组与 PAT 卡按本 spec 其余需求呈现）

#### Scenario: off 档不受影响

- **WHEN** `TENANCY=off` 下打开 console
- **THEN** 仅呈现上游 admin 视图，无欢迎卡与 OIDC 登录入口

### Requirement: 根路径导流到用户面板

`TENANCY=oidc` 下访问 console 根路径（`/`）SHALL 到达用户面板（`/me`）：未登录显示未登录欢迎卡，已登录显示「我的连接」面板。管理台路由（`/overview` 等）不参与导流，保持既有 admin token 解锁规则；`TENANCY=off` 下根路径与管理台行为逐字节不变。

#### Scenario: 匿名根路径到达欢迎卡

- **WHEN** `TENANCY=oidc` 下未登录用户访问 `/`
- **THEN** 最终到达 `/me` 并呈现未登录欢迎卡，不出现管理员 token 解锁面

#### Scenario: 已登录根路径到达面板

- **WHEN** 已登录租户访问 `/`
- **THEN** 到达 `/me` 的「我的连接」面板

#### Scenario: 管理台路由不导流

- **WHEN** 直连 `/overview` 等管理台路由
- **THEN** 按既有 admin token 规则呈现（解锁面或已解锁视图），不发生导流

#### Scenario: off 档不变

- **WHEN** `TENANCY=off` 下访问 `/`
- **THEN** 行为与上游一致（无导流，管理员直面原样）

### Requirement: 用户面板连接生命周期

MT 模式下 console 提供用户面板：连接列表（含状态）、新增 API key 连接、发起 OAuth 连接、删除、改名、试跑 Action。新增表单的 provider 选择走搜索式选择器（Dialog 弹层 + 客户端过滤 + 只渲染前 N 条匹配），列表排除仅支持 no_auth 的 provider（由免鉴权折叠组承载）；authType 选项仅 API Key / OAuth（手动 no_auth 创建不落库、与自动虚拟行同投影，不提供该路径）。用户自建连接与虚拟免鉴权连接分组呈现：自建连接置前；虚拟连接独立分组、默认收起、标题带计数；虚拟行不提供删除（对 no_auth provider 的断开会当场重建虚拟行，删除是无效操作）。

#### Scenario: 列表含状态

- **WHEN** 用户打开面板且存在已过期或需重授权的 OAuth 连接
- **THEN** 列表以可区分状态展示（正常/需重授权），并提供重授权入口

#### Scenario: 粘贴式新增

- **WHEN** 用户经搜索选择器选定 provider、粘贴 API key 保存
- **THEN** 连接按租户加密落库，凭证不再回显

#### Scenario: 搜索式选择 provider

- **WHEN** 用户在新增表单点击「选择提供商」并输入搜索词
- **THEN** 弹层内客户端过滤全量目录、只渲染前 N 条匹配；行内呈现 displayName + service id + OAuth 能力标记，选中后 authType 可选项随 provider 能力联动

#### Scenario: 仅 no_auth provider 不入选择器

- **WHEN** 目录中某 provider 的 authTypes 与 {api_key, oauth2} 交集为空
- **THEN** 该 provider 不出现在选择器结果中（其可用性由免鉴权折叠组表达）

#### Scenario: authType 无 no_auth

- **WHEN** 用户展开新增表单的 authType 选择
- **THEN** 选项仅 API Key 与 OAuth（provider 支持时），不含 no_auth

#### Scenario: OAuth 发起到回调

- **WHEN** 用户发起 OAuth 连接并完成 provider 授权回调
- **THEN** 连接出现在面板；provider 侧失败时显示上游错误码与信息

#### Scenario: 试跑 Action

- **WHEN** 用户在面板选择动作并提交输入
- **THEN** 以本人租户连接执行并展示结果，走与运行面相同的策略校验

#### Scenario: 虚拟连接分组

- **WHEN** 面板呈现连接列表且目录中存在免鉴权 provider 的虚拟连接
- **THEN** 用户自建连接成组置前；虚拟连接独立分组「免鉴权数据源（无需配置，直接可用）」默认收起、标题带条目计数
- **AND** 虚拟行不渲染删除入口；展开分组后条目可正常用于试跑与后续调用

#### Scenario: off 档无用户面板

- **WHEN** `TENANCY=off` 下打开 console
- **THEN** 仅呈现上游 admin 视图，无用户面板与 OIDC 登录入口

### Requirement: PAT 管理入口

用户面板提供 PAT 铸造（明文一次性展示）、列表（名称、最近使用时间）与撤销；PAT 卡固定置于连接列表之前（不随已有 PAT 数量或连接数量漂移），卡内说明指引把令牌粘贴到 agent 平台（如壹座）的连接器设置。

#### Scenario: 铸造即展示一次

- **WHEN** 用户铸造 PAT
- **THEN** 明文仅本次展示，提示复制；列表此后仅显示元数据

#### Scenario: 固定置顶

- **WHEN** 用户面板呈现
- **THEN** PAT 卡位于连接列表之前，无论用户已有多少 PAT 或连接

#### Scenario: 接入指引

- **WHEN** PAT 卡呈现
- **THEN** 卡内含指引文案：把令牌粘贴到 agent 平台（如壹座）的连接器设置中

### Requirement: 用户面板运行记录

`TENANCY=oidc` 下用户面板提供本租户的最近运行记录：只读路由 `GET /api/tenant/runs` 按 `runWithTenant` 租户限定返回该租户名下一切调用（含 service PAT 的 OBO 代调）最近 20 条（不分页）；响应为投影字段（时间/耗时/成败/actionId/caller/连接名/errorCode/errorMessage/inputSummary/outputSummary 与 PAT 名映射），不回传 runtimeTokenId、tenantId、policy 明细。`/me` 面板以运行记录卡呈现：默认收起、标题带条目计数、手动刷新（不轮询）、置于试跑卡之后。

#### Scenario: 最近调用列表

- **WHEN** 已登录租户展开运行记录卡
- **THEN** 呈现本租户最近 20 条调用（时间+耗时、成败、actionId、caller、连接名、发起 PAT 名），最近优先

#### Scenario: 投影剔除内部标识

- **WHEN** 运行记录数据返回租户侧
- **THEN** 不含 runtimeTokenId、tenantId、policy 检查明细；发起方以 PAT 名展示（OBO 代调的发起令牌属服务方、已删除令牌等无匹配场景统一回退中性占位文案，不区分原因）；面板自身发起（`caller: web`）的调用不呈现任何令牌归因——该次调用未使用令牌，占位文案仅留给无法指名的令牌

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

### Requirement: 双语 zh-CN/en

console 界面文案双语：浏览器语言检测 + 手动切换 + 持久化偏好；`LOCALE_DEFAULT` 可强制部署级默认（我方部署 zh-CN，开源发布默认 en）；缺失键回退 en。

#### Scenario: 语言检测与切换

- **WHEN** 首次访问且浏览器语言为 zh 系
- **THEN** 界面呈 zh-CN；用户切换 en 后偏好持久化，后续访问保持 en

#### Scenario: 部署默认覆盖检测

- **WHEN** 部署设置 `LOCALE_DEFAULT=zh-CN` 且浏览器语言为 en 且用户无既有偏好
- **THEN** 界面呈 zh-CN（用户仍可手动切换）

#### Scenario: 不翻译的边界

- **WHEN** 查看任意 action 的名称、描述或 agent guide
- **THEN** 保持上游目录原文（英文），不因界面语言而变
