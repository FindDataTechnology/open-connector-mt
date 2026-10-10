# tenant-console Specification

## Purpose
console 的用户面板（独立壳层 + 连接全生命周期 + PAT 管理）与 zh-CN/en 双语机制；`TENANCY=off` 下 console 保持上游 admin 面孔。

## Requirements

### Requirement: 用户面板独立壳层

`TENANCY=oidc` 下 `/me` 用户面板使用独立于管理台的壳层版式与品牌：顶部通栏品牌条 + 纵向主区，不借用管理台的两列网格布局；品牌为「萬星连接器 / Wanxing Connector」，管理台品牌保持上游原文。用户面板顶栏不提供指向管理台的入口（普通租户在 admin token 后会撞解锁墙；管理员经直连 URL 进管理台，「登录后落 `/me`」规则不变）。

#### Scenario: 版式独立于管理台布局

- **WHEN** `TENANCY=oidc` 下打开 `/me`
- **THEN** 页面呈顶部通栏品牌条 + 主区的纵向版式，任何屏幕宽度下都不出现管理台侧栏列挤压头部元素的破碎排布

#### Scenario: 品牌正名

- **WHEN** 用户面板呈现品牌
- **THEN** 显示「萬星连接器 / Wanxing Connector」（随界面语言），不显示上游的「本地运行时控制台」
- **AND** 管理台（`TENANCY=off` 或直连 admin 面）的品牌文案不变

#### Scenario: 顶栏无管理入口

- **WHEN** 普通租户查看用户面板顶栏
- **THEN** 不存在指向 `/overview` 等管理台路由的链接；直接访问管理台路由仍按既有 admin token 规则呈现解锁面

#### Scenario: off 档不受影响

- **WHEN** `TENANCY=off` 下打开 console
- **THEN** 仅呈现上游 admin 视图，版式与品牌逐字节不变（本需求全部行为仅限 `TENANCY=oidc`）

### Requirement: 未登录引导页

未登录用户打开 `/me` 时，呈现居中引导卡片：萬星连接器品牌 + 一句功能说明（托管 SaaS 连接、铸造 PAT 授权 agent 平台）+ 登录按钮，替代现状的孤句加按钮。

#### Scenario: 居中引导卡

- **WHEN** 未登录用户打开 `/me`
- **THEN** 页面呈居中卡片，含品牌、功能说明文案与唯一的登录入口按钮

#### Scenario: 登录后进入面板

- **WHEN** 用户点击登录并完成 OIDC 回流
- **THEN** 呈现已登录的用户面板（连接分组与 PAT 卡按本 change 其余需求呈现）

### Requirement: 用户面板连接生命周期

MT 模式下 console 提供用户面板：连接列表（含状态）、新增 API key 连接、发起 OAuth 连接、删除、改名、试跑 Action。用户自建连接与虚拟免鉴权连接分组呈现：自建连接置前；虚拟连接独立分组、默认收起、标题带计数；虚拟行不提供删除（对 no_auth provider 的断开会当场重建虚拟行，删除是无效操作）。

#### Scenario: 列表含状态

- **WHEN** 用户打开面板且存在已过期或需重授权的 OAuth 连接
- **THEN** 列表以可区分状态展示（正常/需重授权），并提供重授权入口

#### Scenario: 粘贴式新增

- **WHEN** 用户为某 provider 粘贴 API key 保存
- **THEN** 连接按租户加密落库，凭证不再回显

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
