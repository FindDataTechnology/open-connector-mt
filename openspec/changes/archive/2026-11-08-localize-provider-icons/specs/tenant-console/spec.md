## ADDED Requirements

### Requirement: 目录图标随发行物分发

应用目录卡片的图标 SHALL 随前端发行物一同分发，渲染交互 SHALL NOT 需要请求第三方域名。

构建 SHALL 从图标源把每个 provider 的图标取到发行物内（`/provider-icons/`），并在映射里
改写为该发行物内路径；单个图标取不到时 SHALL 只让该 provider 保留远程地址，且 SHALL
报告失败条数，不得让整次构建失败，也不得静默把该 provider 降级成无图。

图标缓存目录 SHALL NOT 进入版本库（随构建生成），且每次构建 SHALL 先清空它，避免图标源
已撤下的条目继续由旧文件提供。

#### Scenario: 内网部署也能画出完整目录

- **WHEN** 发行物被部署在无法访问外部域名的环境里，用户打开应用目录
- **THEN** 卡片显示随发行物分发的图标，不发起任何第三方图标请求

#### Scenario: 单个图标缺失不影响其余

- **WHEN** 构建期某个 provider 的图标下载失败
- **THEN** 该 provider 的映射保留原始远程地址，其余 provider 正常本地化
- **AND** 构建成功并在日志中给出失败条数
