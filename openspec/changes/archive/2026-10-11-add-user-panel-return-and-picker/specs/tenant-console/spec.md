# tenant-console Delta — add-user-panel-return-and-picker

## MODIFIED Requirements

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
