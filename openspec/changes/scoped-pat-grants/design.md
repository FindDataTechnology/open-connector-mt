## Context

见 proposal.md — Why。设计上只补三件约束：

1. **上游可合并性是第一约束**：`TENANCY=off` 必须与上游字节兼容，租户代码集中于 fork-new 文件；触碰上游动作路径是最后手段。
2. **策略层已经完备**：`core/action-policy.ts` 三层求交（deployment / token / …），`empty allowlist = 不限制`，`blocked` 优先于 `allow`；`action-runner.ts`、`proxy-runner.ts`、`connect-server.ts` 都已在执行。本变更不新增执行点，只新增**签发点**与**解释点**。
3. **铸造端点今天只认 OIDC 会话**：`POST /api/tenant/pats` 走 `requireUser`，user_pat 不能铸 PAT。单轨注入后，消费侧需要在无浏览器会话时也能派生范围令牌（桌面端），否则退化为全权粘贴。

## Goals / Non-Goals

**Goals:**

- 让「带范围的 PAT」成为一等凭据：签得出、拒得清、撤得掉、可回溯到派生者。
- 保持老调用方零感知：不带范围的铸造与今天完全一致。
- 把「范围不足」与「凭据失效」在错误语义上分开，使消费侧能分别渲染授权卡与重连卡。

**Non-Goals:**

- 不收窄任何已签发的全权令牌（不做强制迁移；消费侧按绑定逐步替换）。
- 不改动目录（`src/providers/**`）与动作分类逻辑。
- 不做 OBO consent 档切换、不做授权 UI、不引入匿名主体。

## Decisions

### D1 范围入参采用「规则列表」而非结构化对象

`allowedActions` 复用既有 `PolicyRule` 语法（`service.action`，支持通配），`allowedConnections` 复用既有连接 id 列表。理由：策略层已按此语法求交，若引入新语法就要在编译层做转换，徒增分叉。备选「结构化 `{provider, operationType}` 列表」被否决——那会把范围语义绑死在校验期，而求交发生在执行期，两者语法必须一致。

范围校验只做**可满足性**：每条动作规则至少命中目录一个动作（`catalog-index` 可查），每个连接 id 属于本租户。不校验「用户是否真的会用它」——那是消费侧的事。

### D2 范围自省走 fork 侧只读查询面，不动上游动作路径

被拒时消费侧**已经知道**它调用的 `actionId`（在工具入参里）。因此无需改上游返回体：新增两个 fork-new 的租户只读端点——

- `GET /api/tenant/scope-explain?actionId=<id>` → `{ provider, operationType, allowed, code, checks[] }`；
- `GET /api/tenant/catalog-coverage?provider=<id>&operations=read,write` → 每类的覆盖与缺口。

第二个端点是必要条件而非锦上添花：消费侧要判「包声明的外部面目录兑现不了」（`unwired`），而**目录只在连接器一侧**。若让 壹座 自己拉目录判断，它就得复制 287k 行的目录索引并跟着上游漂移——那是把公共资产私有化，明确否决。

- 为什么不是「在 MCP 结果里加结构化字段」：`src/mcp.ts` 与 `src/server/actions/action-runner.ts` 属上游，加字段会进入双周合并冲突面，而且 `checks[]` 里的规则模式对模型是噪音。
- 为什么不是「解析错误文案」：文案属上游、非契约，且明确不翻译，解析它等于把实现细节当接口。
- 备选（若消费侧拿不到 actionId）：退到在 `action-runner` 结果里加一个只读 `scope` 字段，按「最小上游触碰」处理并在 tasks 里单列。**触发条件**：消费侧实施（`add-connector-bindings`）时若发现被拒的调用拿不到 `actionId`（例如服务端直接代调而不经模型选工具），在本 change 内追加该任务并标注 upstream-touched，不另开 change——本 change 已实施，备选未触发。
- 端点必须只读：查一次不等于执行一次，不得写运行记录、不得改写令牌、不得触发外部调用。

### D3 铸造同时接受 user_pat（衰减铸造）

`POST /api/tenant/pats` 增加 `Bearer user_pat` 鉴权分支：以调用令牌的策略为上界，请求范围必须是其子集，越界 403，不静默裁剪。理由：

- 单轨注入需要「为绑定派生窄令牌」，而桌面端没有浏览器会话，OIDC 分支不可用。
- 衰减在数学上单调，天然安全：派生路径不可能提权，且给存量全权 PAT 提供了「自证收窄」的迁移通道——用户不必先撤销再重建。
- 备选「放开 localhost 到 cross-mint 白名单」被否决：那会让任意本机进程借用户会话铸全权令牌，比现状更差。

子令牌记录 `parent_token_id`；父撤销时连带失效（见 D5）。

### D4 同名重铸 = 并集 + 吊销旧令牌

单轨下绑定会反复重铸（每次授权扩展）。若同名重铸是覆盖，用户已授予的范围会在下一次授权时丢失；若是新增，令牌数量会随授权次数膨胀。取并集 + 吊销旧令牌，使「每绑定恒一枚有效令牌、范围单调不减」。

范围收窄因此只能靠「撤销 + 重铸」，这是有意的：收窄是破坏性操作，不该被一次普通授权顺带完成。

### D5 落库采用两列，撤销按父链连带

`runtime_tokens` 新增 `purpose`（归属标签）与 `parent_token_id`（派生来源）。

撤销的级联放在 `RuntimeTokenService.revokeToken` 内实现，而非下推到三个 store：按 `parentTokenId` 广度优先找子令牌并逐个 `revoke`，深度封顶 4（真实链深 1–2）。这样 `IRuntimeTokenStore` 接口零改动，三方 store 只多写两列——fork delta 保持最薄。代价是级联非单事务，子令牌可能在父删除后、子删除前短暂存活；`parentTokenId` 的语义是「派生自」，父已不在时子仍可被解析，因此 tasks 里补了「父撤销后子令牌 401」的用例来锁住可观察行为。若日后 `revoke` 争用成为问题，再退到 store 层用单条 `delete ... where parent_token_id in (...)` 批量删除（接口需要扩，届时单独评估）。

级联可选：`revokeToken(id, { cascade: false })` 只退掉这一枚。同名重铸（D4）用它——新令牌取并集，旧令牌挂着的子令牌仍落在父范围之内，不该被一并带走。父子链的「撤销父 → 子失效」用例在 `runtime-token-service.test.ts` 里锁住。

### D6 修订：操作类范围作为第二种白名单（原 D1 部分推翻）

对侧（壹座 `add-connector-bindings`）的授权单元是 `(provider, operationType)`，落地时发现 D1 的「只用规则列表」在这一粒度上是错的，且两条退路都不成立：

- 用 `kingdee.*` 铸造会把 write/destructive 一起授予——「支付渠道只读」这类声明当场失真，正是本变更要消灭的东西；
- 把 `(kingdee, read)` 展开成动作 id：大 provider 撞 `policyRuleListMaxItems = 128`，且目录新增的动作永远不在已签令牌里（范围在铸造时冻结）。

故令牌策略增加 `allowedOperations?: OperationScope[]`（`{provider, operationType}`），与 `allowedActions` **同层取并**；「该层是否受限」改为「二者同时为空才不受限」。求交语义不变，只是多了一种可表达的白名单形态，且仍然只收紧不放宽。D1 里「结构化对象被否决」的理由（避免校验期与执行期两套语法）由本决策接管：执行期直接比对动作自带的 `service` / `operationType`，不存在转换层。

衰减（D3）随之扩展为双形态覆盖：父规则 `*` / `provider.*` 覆盖任一子类声明；父类声明覆盖「该类下的单个动作规则」，但 MUST NOT 覆盖 `provider.*` 或另一类；子令牌未声明动作与类范围时继承父令牌的两种范围。

落地代价：`src/core/action-policy.ts` 由「不动」变为 upstream-touched（加字段、加一类命中分支，`evaluateProxy`/`evaluateTrigger` 零改动），存储加一列（0020），OpenAPI 只增不改。

### D6b 连接列表过滤复用既有求值，不做新逻辑

`list_connections` 的过滤已由 `evaluateConnection` 在 `connect-server.ts` 中完成；本变更只把它在租户面上的语义写进契约（`tenant-mcp`），实现零改动。风险是「过滤存在但语义未测」——tasks 里补一条针对白名单的用例。

## 代码落点（fork-new / upstream-touched）

| 路径                                                         | 性质                        | 改动                                                                                                                                                                                                |
| ------------------------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/tenancy/tenant-routes.ts`                        | **fork-new**                | 铸造入参收 `allowedActions`/`allowedConnections`/`purpose`；新增 `Bearer user_pat` 分支与衰减校验；新增 `GET /api/tenant/scope-explain` 与 `GET /api/tenant/catalog-coverage`；PAT 列表加 `purpose` |
| `CatalogStore`（`catalog.actionsById` / `catalog.providers`） | **upstream 文件，只读调用** | 可满足性与覆盖判定复用既有内存索引与 provider 列表，不新增导出、不改实现（`catalog-index.ts` 已在其加载期建好索引）                                                                                  |
| `src/server/storage/runtime-token-service.ts`                | **upstream-touched**        | `createToken` 已有 `policy` 入参，补 `purpose`/`parentTokenId` 透传；`revokeToken` 加可选 `{ cascade }`（默认连带子令牌，签名向后兼容）                                                              |
| `src/server/storage/{sqlite,postgres,d1}/runtime-store.ts`   | **upstream-touched**        | 读写两列（insert 占位符 12→14）；store 接口零改动                                                                                                                                                    |
| `src/server/storage/runtime-sql.ts`                          | **upstream-touched**        | 行映射补两列（`readOptionalString`）                                                                                                                                                                |
| `src/core/action-policy.ts`                                  | **upstream-touched（D6 修订）** | `TokenPolicy.allowedOperations?` 与令牌层的「规则 ∪ 类」并集命中；`blocked`/proxy/trigger 分支零改动                                                                                                |
| `migrations/0020_*.sql` + `migrations/postgresql/0020_*.sql`  | **fork-new**                | `allowed_operations text not null default '[]'`（旧行解码为无类授权）                                                                                                                               |
| `src/mcp.ts` / `src/server/actions/action-runner.ts`         | **不动（D2 首选）**         | 仅当 D2 退到备选时触碰                                                                                                                                                                              |
| `web/`（用户面板 PAT 卡）                                    | **fork-new**                | 列表显示 `purpose` 与范围摘要，逐枚撤销                                                                                                                                                             |
| `migrations/0019_*.sql` + `migrations/postgresql/0019_*.sql` | **fork-new**                | 两方言同文（见迁移计划）                                                                                                                                                                            |

## Risks / Trade-offs

- **[范围外动作被拒但用户不知道怎么授权]** → D2 的 `scope-explain` 必须返回 `provider` + `operationType`，消费侧才画得出「去授权：飞书·读取」；否则拒因退化成一句英文。
- **[同名重铸取并集导致范围只会变宽]** → 有意为之；收窄走撤销。消费侧 UI 必须明说「重铸只增不减」，否则用户会以为换了连接就收窄了。
- **[衰减铸造成为令牌繁殖路径]** → 每绑定恒一枚有效令牌（D4）+ `purpose` 可回溯（D5）+ 父撤销连带，三条合起来封住；仍需在用户面板显示总令牌数与派生关系。
- **[已签发的全权 PAT 不受本变更影响]** → 这是迁移成本不是缺陷；若直接失效会打断所有在跑部署。消费侧在 `add-connector-bindings` 里逐步替换，并在面板显式标注全权令牌。
- **[`list_connections` 过滤语义今天没有针对性用例]** → tasks 补用例；不补就等于把「已实现」当「已验证」。

## Migration Plan

两方言**同文**，编号接上游最新（当前 sqlite/pg 均到 0018）：

```sql
-- migrations/0019_pat_scope_grants.sql
-- migrations/postgresql/0019_pat_scope_grants.sql
alter table runtime_tokens add column purpose text;
alter table runtime_tokens add column parent_token_id text;

create index if not exists runtime_tokens_parent on runtime_tokens (parent_token_id);
```

- 两列均可空、无默认值 ⇒ 存量行零改写，`TENANCY=off` 行为不变。
- 索引仅服务「父撤销连带」这一条批量查询。
- 回滚：两方言 `alter table ... drop column`（SQLite ≥ 3.35 支持；镜像内 node:sqlite 满足）；索引同删。业务回滚不需要数据迁移——老代码忽略新列。
- 部署顺序：先上连接器（本变更），再上消费侧（`add-connector-bindings`）；反向不成立（消费侧会调用尚不存在的范围入参）。

## Open Questions

- 用户面板「令牌总览」是否要画派生树（父→子），还是只显示每枚的 `purpose` 与父令牌名？不影响规格与任务拆解，实施时按面板空间定。
