# scoped-pat-grants

## Why

用户 PAT（`user_pat`）今天铸造时把策略写死成空（`tenant-routes.ts` 的 `emptyPolicy()`），而策略层是**空 allowlist = 不限制**（`core/action-policy.ts` 分层求交：`allowedActions.length === 0` 直接 `continue`，`allowedConnections.length === 0` 直接放行）。结果：一枚用户 PAT 等价于「本租户全部连接 × 目录全部 1571 个 provider 的全部动作」。

下游三个消费者都只能拿这张全权票：壹座按用户存 PAT 并注入 dsh profile、谦面以服务主体代调、萬星 served agent 尚未接线。包与 agent 层面已经声明了它们需要的外部系统面（`connector_bindings`、`mcpServers[].allowTools`），但没有任何一层能把它翻译成 token 范围——声明是死的，凭证是全权的。

收窄的零件其实已经齐了：`allowedActions` / `allowedConnections` / `blockedActions` 三层策略在 `action-runner.ts`、`proxy-runner.ts`、`connect-server.ts` 都真在执行。缺的只有一件事：**谁来签发一枚带范围的 PAT，以及被拒时怎么让调用方知道该申请什么范围**。

## What Changes

- **`POST /api/tenant/pats` 接受范围**：请求体从 `{name}` 扩展为 `{name, purpose?, allowedActions?, allowedConnections?}`。两个 allowlist 若存在，SHALL 在铸造时校验：`allowedActions` 的每个 pattern 必须命中目录中至少一个动作，`allowedConnections` 的每个 id 必须是本租户现存连接。校验失败 400 且不产生 token。两者缺省仍是空（**行为向后兼容**：老调用方拿到的仍是全权 PAT）。
- **同名重铸是并集扩展而非覆盖**：同一身份下以同名 `name` 再次铸造，SHALL 把新范围并入旧范围、吊销旧 token、返回新 token。这是 binding 重铸的幂等基础（范围只增不减，撤销靠删）。
- **PAT 记录携带归属**：token 记录新增 `purpose`（自由文本标签，如 `binding:erp-supply/kingdee-cloud`），`GET /api/tenant/pats` 返回 `purpose`。一枚用户从 1 张 PAT 变成 N 张之后，没有归属标签就无法判断该撤销哪一张。
- **策略拒绝的结构化载荷**（设计待裁，见 design D2）：当执行因 `action_not_allowed` / `connection_not_allowed` 被拒时，调用方 SHALL 能取得该动作的 `provider`、`operationType` 与缺失的规则层，用于渲染「去授权」；人类可读 message 与既有错误码保持不变。
- **按连接白名单过滤连接列表**：持有范围 PAT 时 `list_connections` 只返回 `allowedConnections` 内的连接（`connect-server.ts` 已有 `evaluateConnection` 过滤，本变更把它在租户面上变成契约的一部分）。
- **控制台 PAT 管理入口显示归属与范围**：用户面板的 PAT 列表从 (name, lastUsedAt) 扩展为 (name, purpose, 范围摘要, lastUsedAt)，并可单张撤销。
- **范围自省面**：新增租户侧只读查询面，回答两件消费侧无法自行判断的事——「这次为什么被拒」（按 action id 返回 provider、operationType 与拒绝层）与「这个 provider 能不能兑现这些操作类」（按 provider + 操作类返回覆盖与缺口）。目录知识因此只存在于连接器一侧，消费侧不必复制目录。

## Capabilities

### New Capabilities

- `scope-introspection`: 租户侧的范围自省查询面——按动作 id 解释拒绝原因，按 provider + 操作类回答目录能力覆盖与缺口，使消费侧能渲染授权入口、并在声明「目录兑现不了」时给出依据。

### Modified Capabilities

- `tenant-auth`: 「用户 PAT」由「无策略的全权令牌」改为「可携带动作与连接范围、同名重铸取并集、带归属标签、可由父令牌衰减派生」；「TENANCY 开关语义」补一句 `TENANCY=off` 下范围 PAT 同样可铸。
- `tenant-mcp`: 「执行归属校验」补「因范围不足被拒时返回结构化 scope 载荷」与「连接列表按 token 的连接白名单过滤」。
- `tenant-console`: 「PAT 管理入口」补归属标签与范围摘要的展示与单张撤销。

## Non-goals

- **不切 OBO consent 档**：`SERVICE_OBO=allow-all` 翻到 `consent` 是服务型 agent 接入（paas 侧 change ③）的前置，本变更不碰。
- **不引入 ephemeral / 匿名主体**：连接器租户模型不变；匿名访客接入已被否决（见 paas 侧决策 c1 部署者主权）。
- **不做授权 UI**：范围申请、授权卡、binding 解析全在壹座侧；连接器只负责「签得出、拒得清、撤得掉」。
- **不新增资金动作面**：与 `add-supply-chain-provider-onboarding` 的二清红线一致，零支付/退款/转账动作。
- **不改 `src/providers/**`\*\*：目录归上游。
- **不做范围收窄收紧**：已签发的全权 PAT 不因本变更失效（不做一次性迁移强制），收窄由消费侧按需重铸。

## 上游文件触碰（upstream-touched）

本仓硬约束是「上游可合并性优先，触碰上游文件是最后手段」。本变更的触碰面是**一处，且有意保留为设计待裁**：

- `src/server/tenancy/tenant-routes.ts`、`src/server/storage/runtime-token-service.ts`、`src/server/storage/*/runtime-store.ts`：租户层与存储层——`tenant-routes.ts` 为 fork-new 文件（tenancy 增量集中于新文件），`runtime-token-service.ts` 与存储实现属上游，需**新增列**（`purpose`）与 `createToken` 的策略入参。列新增走新 migration（编号接上游最新），`TENANCY=off` 路径行为不变。
- `src/mcp.ts` / `src/server/actions/action-runner.ts`：**仅在 design D2 裁定「结构化 scope 载荷必须经 MCP 结果返回」时触碰**。若 D2 采纳首选方案（复用既有 `action_not_allowed` 错误码 + 消费侧回查 `search_actions` 已返回的逐动作策略决策），则本变更**零上游动作路径改动**。
- `catalog/**` 与 `registry*.generated.ts`：生成物，不手工改。

## Impact

- **API**：`POST /api/tenant/pats`（请求体扩展，向后兼容）、`GET /api/tenant/pats`（响应加 `purpose`）、用户面板 PAT 列表；错误响应新增可选 `scope` 字段（D2 裁定后）。
- **DB**：一枚新 migration（PAT 记录加 `purpose` 列），三方方言（sqlite / postgres / d1）同步。
- **下游**：壹座 `connector-credentials` 可按 binding 铸造 N 枚范围 PAT；谦面服务主体可按 agent 收窄；萬星 served agent 复用同一端点。
- **不变量**：`TENANCY=off` 与上游字节兼容；部署级 `OOMOL_CONNECT_ALLOWED_ACTIONS` 仍是上层封顶，用户范围只能在其内取交集，**不能越界**。
- **验收**：`npm test`（含三方方言 store 用例）、`npm run fix-check`、`openspec validate scoped-pat-grants --strict`；新增用例覆盖「范围 PAT 越界被拒」「同名重铸取并集且旧 token 失效」「空范围向后兼容」「未授权连接不出现在 list_connections」。
