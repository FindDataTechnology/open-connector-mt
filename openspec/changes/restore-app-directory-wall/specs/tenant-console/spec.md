# Spec Delta

## MODIFIED Requirements

### Requirement: 用户面板连接生命周期

MT 模式下 console 提供用户面板：连接列表（含状态）、新增 API key 连接、发起 OAuth 连接、删除、改名、试跑 Action。新增表单的 provider 选择走搜索式选择器（Dialog 弹层 + 客户端过滤 + 只渲染前 N 条匹配），列表排除仅支持 no_auth 的 provider（由免鉴权折叠组承载）；authType 选项仅 API Key / OAuth（手动 no_auth 创建不落库、与自动虚拟行同投影，不提供该路径）。用户自建连接与虚拟免鉴权连接分组呈现：自建连接置前；虚拟连接独立分组、默认收起、标题带计数；虚拟行不提供删除（对 no_auth provider 的断开会当场重建虚拟行，删除是无效操作）。

面板 SHALL 同时提供**可浏览的应用目录**（浏览式连接入口）：为目录中每个可配置 provider（`authTypes` 与 `{api_key, oauth2}` 有交集的）呈现一张卡片，含图标、显示名与其首个目录分类；已连接的 provider SHALL 置于未连接之前并显式标注已连接条目数；免鉴权 provider 以「免认证」呈现而非提供连接动作；一次渲染的卡片数有上限，超出部分经一次显式展开操作呈现。目录 SHALL NOT 承载第二套连接实现——点击一张卡片与在搜索式选择器里选中同一 provider 是同一个动作，结果都是把该 provider 落到新增表单上。

面板 SHALL 接受深链 `/me?add=<service>`：当 `<service>` 是目录内的可配置 provider 时，页面 SHALL 等同于用户点击了该卡片（新增表单预填该 provider 与其支持的默认 authType、表单滚入视口、首个输入获得焦点）；当 `<service>` 未知、为空、或指向仅 no_auth 的 provider 时，页面 SHALL 正常渲染且不做任何预填，MUST NOT 报错或清空用户已输入的内容。深链 SHALL NOT 提升任何权限：它只预填一次表单，连接仍由用户显式提交。

目录区域 SHALL 带一个稳定的页面内锚点，使外部深链（如壹座连接卡片的「浏览可连接的目录」）落在该区域而非页面顶部；该锚点与 `?add=` 查询 SHALL 互不干扰（任一存在时，其余查询参数与哈希不被丢弃）。

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

#### Scenario: 目录墙呈现且可与连接表单互认

- **WHEN** 已登录租户打开 `/me` 且目录中存在可配置 provider
- **THEN** 面板呈现应用目录卡片墙，每张卡含图标、显示名与首个分类，已连接的 provider 置前并标注已连接数
- **AND** 点击任意一张卡后，新增表单的 provider 为该卡对应的 provider，表单进入视口且首个输入获得焦点
- **AND** 卡片墙区域带稳定锚点，`/me#catalog` 直接滚到该区域

#### Scenario: 深链把选择落到表单上

- **WHEN** 已登录租户打开 `/me?add=<目录内的可配置 service>`
- **THEN** 新增表单预填该 provider 与它支持的默认 authType，表单滚入视口、首个输入获得焦点
- **AND** 用户仍需显式提交才会创建连接，深链本身不创建任何连接

#### Scenario: 未知或不可配置的 service 不改变页面

- **WHEN** 用户打开 `/me?add=<不存在的 service>`、`/me?add=`，或 `?add=<仅 no_auth 的 provider>`
- **THEN** 页面按常渲染，不预填任何 provider，不报错，也不清空用户已输入的表单内容

#### Scenario: off 档无用户面板

- **WHEN** `TENANCY=off` 下打开 console
- **THEN** 仅呈现上游 admin 视图，无用户面板与 OIDC 登录入口

### Requirement: 未登录引导页

`TENANCY=oidc` 下未登录用户打开 `/me`（含经根路径导流到达）时，系统 SHALL 呈现居中欢迎卡片：萬星连接器品牌 + 一句话产品定位 + 三步行引导（① 统一身份登录 ② 添加 SaaS 连接 ③ 把连接交给 agent——经跨站授权直接接通，或在 agent 平台粘贴一枚自铸令牌）+ 「了解产品」链接 + 一行安全承诺 + 唯一的登录入口按钮。SHALL 保持登录按钮为页面唯一登录入口。「了解产品」链接 SHALL 新标签打开官网产品介绍页，按界面语言选页（zh 系语言指中文页，其余语言指英文页）；定位与安全口径 SHALL 与官网介绍页同源（下限口径：1500+ 服务、万级预置动作；凭据加密托管、执行面不对公网）。本要求仅限 `TENANCY=oidc`。

第三步的表述 SHALL 与两条真实通路一致，MUST NOT 把「手动铸造并粘贴」写成唯一路径（消费方已支持零粘贴跨站铸造）。

#### Scenario: 居中引导卡

- **WHEN** 未登录用户打开 `/me`
- **THEN** 页面呈居中卡片，品牌、定位句、三步行、了解产品链接、安全承诺与登录按钮齐列，登录按钮为唯一登录入口

#### Scenario: 第三步不把粘贴写成唯一路径

- **WHEN** 未登录用户阅读三步行引导
- **THEN** 第三步同时陈述「跨站授权直接接通」与「粘贴自铸令牌」两条通路，不将后者表述为唯一方式

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

### Requirement: PAT 管理入口

用户面板提供 PAT 铸造（明文一次性展示）、列表（名称、归属标签、范围摘要、最近使用时间）与撤销；PAT 卡固定置于连接列表之前（不随已有 PAT 数量或连接数量漂移），卡内说明指引如何把令牌交给 agent 平台（如壹座）：SHALL 先陈述跨站授权接通（免粘贴，消费方支持时），再把「手动铸造令牌并粘贴到连接器设置」作为回退方式陈述。

列表 SHALL 逐枚显示归属标签 `purpose` 与范围摘要（动作白名单条目数与其覆盖的 service、连接白名单条目数）；未设范围（全权）的令牌 SHALL 显式标注为全权，MUST NOT 以空白呈现让人误以为是「无权限」。每枚令牌 SHALL 可单独撤销。

#### Scenario: 铸造即展示一次

- **WHEN** 用户铸造 PAT
- **THEN** 明文仅本次展示，提示复制；列表此后仅显示元数据

#### Scenario: 固定置顶

- **WHEN** 用户面板呈现
- **THEN** PAT 卡位于连接列表之前，无论用户已有多少 PAT 或连接

#### Scenario: 接入指引

- **WHEN** PAT 卡呈现
- **THEN** 卡内指引先说明可经跨站授权免粘贴接通，再说明可把铸造出的令牌手动粘贴到 agent 平台（如壹座）的连接器设置中
- **AND** 不将手动粘贴表述为唯一方式

#### Scenario: 全权令牌显式标注

- **WHEN** 用户持有未设范围的 PAT
- **THEN** 该行显式标注为全权令牌，不渲染为空白或「无范围」

#### Scenario: 范围摘要可读

- **WHEN** 用户持有带范围的 PAT
- **THEN** 该行显示动作白名单覆盖的 service 与连接白名单条目数，供用户判断影响面

#### Scenario: 逐枚撤销

- **WHEN** 用户在列表中点某枚令牌的撤销
- **THEN** 只有该枚令牌失效，同身份其他令牌不受影响
