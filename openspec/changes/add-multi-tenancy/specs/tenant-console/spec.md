# tenant-console Specification

## Purpose

console 的用户面板（连接全生命周期 + PAT 管理）与 zh-CN/en 双语机制；`TENANCY=off` 下 console 保持上游 admin 面孔。

## ADDED Requirements

### Requirement: 用户面板连接生命周期

MT 模式下 console 提供用户面板：连接列表（含状态）、新增 API key 连接、发起 OAuth 连接、删除、改名、试跑 Action。

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

#### Scenario: off 档无用户面板
- **WHEN** `TENANCY=off` 下打开 console
- **THEN** 仅呈现上游 admin 视图，无用户面板与 OIDC 登录入口

### Requirement: PAT 管理入口

用户面板提供 PAT 铸造（明文一次性展示）、列表（名称、最近使用时间）与撤销。

#### Scenario: 铸造即展示一次
- **WHEN** 用户铸造 PAT
- **THEN** 明文仅本次展示，提示复制；列表此后仅显示元数据

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
