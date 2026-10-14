# tenant-console Delta — add-welcome-entry

## ADDED Requirements

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

## MODIFIED Requirements

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
