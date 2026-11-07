# add-supply-chain-provider-onboarding — design

## Context

需求契约（只读引用，非本仓文件）：`fd-erp-vertical-templates/templates/supply-chain/connector-pack/pack.json`（金蝶/WMS/支付/双门户绑定契约）与 `fd-erp-vertical-templates/docs/connector-onboarding-supply-chain.md`（目录核验 + 立项要点，2026-11-07）。ERP 线只出需求与验收判据；provider 资产归本仓，且要求本仓裁定新增载体。

本仓机制事实（研究证据，全部只读核验）：

1. **唯一受支持的 provider 源**是 `src/providers/<service>/definition.ts`（`CONTRIBUTING.md` §Adding Providers；`.codex/skills/add-provider/SKILL.md`）。`catalog/apps/*.json` 与 `src/providers/registry*.generated.ts` 是生成物（gitignored 本地运行时数据），由 `npm run generate:catalog` 整目录再生；`scripts/ensure-generated.ts` 在 `npm start` / `npm run dev` 时检测过期并自动再生——**对生成物打补丁不稳定，下次启动即被冲掉**。
2. `scripts/provider-source.ts` 的 `loadProviderSources()` **硬编码扫描 `src/providers`**：目录之外的定义生成器看不见。
3. `src/catalog-index.ts` `readCatalogIndex()`：启动索引必须与 `catalogDir` 逐文件、逐字节一致，否则启动失败（"does not describe …; run npm run generate:catalog"）——自拼 overlay 目录必须自建一致索引（或无索引慢启动）。
4. `src/server/connector-runtime.ts`：`executorModules` 静态 import 自 `registry.generated.ts`；`loadCatalog` 的 `executableServices: Object.keys(executorModules)` 与 `new ProviderLoader(executorModules)` 都只认它——**不在 registry 里的 service 一律 `catalogOnly`（元数据可见、本地不可执行）**。overlay 载体必须在 `connector-runtime.ts`（上游文件）加合并点。`assets?: ConnectorAssets` 虽可覆盖 catalogDir，但只解决元数据可见，不解决执行。
5. **回调机制已备**：`src/triggers/`（`subscriptions.ts` / `trigger-runner.ts`，mode=webhook，operation=subscribe/receive/reconcile/cancel，nonce 校验 + provider 自验签 + 64 KiB rawBody）+ `trigger_subscriptions` 表（migration 0017，含 `provider_account_id` 列）+ 管理面 `/api/trigger-subscriptions`（`docs/runtime-api.md` §Provider Triggers）。公网 webhook 入口归 Open Flow，`receive` 由其投递进本运行时。
6. `docs/marketplace.md`：Marketplace 是远端执行面（与本地目录取交集的 allowlist），不构成新 provider 载体。
7. 硬约束（`openspec/config.yaml`）：「Never modify src/providers/** (the 1.38M-LOC catalog belongs to upstream)」；TENANCY=off 字节兼容针对 tenancy 实现；触碰上游文件是 last resort；`docs/adr/0001`：「fork delta 必须薄，src/providers/** 永不改」。ERP 线核验文档 §2.5 将「新增文件是否属硬约束解释空间」明确留给本仓裁定。

## Goals / Non-Goals

**Goals:**

- 裁定并落档 fork 侧新增 provider 的合规载体（证据链 + 被否方案 + 上游归化路径）。
- 补齐支付渠道商户侧只读面（wechatpay/alipay）与回调记录，供 ERP 结算中心日终对账。
- WMS 骨架契约与验收判据先立档，实现等锚点客户形态确认。
- 金蝶增补评估结论 + upstream 增补项清单，本仓零触碰。

**Non-Goals:**

- 见 proposal Non-goals（零资金写面、无 WMS 实现、不改 kingdee、不建 overlay、无迁移、无银联首版）。

## Decisions

### D1: 载体裁定——in-tree additive（`src/providers/<service>/` 全新目录），upstream PR 为归化路径；overlay/运行时注册被否

- **落地方案**：新 provider 以 `src/providers/wechatpay/`、`src/providers/alipay/` 全新目录进入，全程零既有文件修改。生成管线（`loadProviderSources` → `generateProviderRegistries` → `generate-catalog.ts`）与 runtime（`ProviderLoader` + `executableServices`）零改动即流通；trigger 经 `ExecutorModule.triggers` 自动注册；clone-baseline ratchet（`provider-source-guards.clone-baseline.test.ts`）继续覆盖新文件。
- **裁定理由**：硬约束的保护对象是**上游对既有 1.38M-LOC 目录的所有权与合并面**（config.yaml 括注；ADR 0001 的动因是 delta 薄、可上游化）。全新目录 = 不改任何上游文件、可直接 upstream PR（文件原样上移），是唯一同时满足「不碰上游文件」与「可上游化」的载体。本节即 ERP 线 §2.5 留给本仓的裁定。
- **被否方案 A（fork overlay 车道）**：`src/providers-fork/` + fork 自建生成链（复用 `createCatalogIndex`/`sortProviders` 拼 `catalog-fork/`）+ `connector-runtime.ts` 加 fork executor 合并点。否决理由：必须触碰上游文件（超出 last-resort 预算）；生成链与注册路径永久分叉双轨维护；新文件逃逸 clone ratchet（质量回退）；provider 永远无法 upstream 归化、终须二次迁移。留作**回退预案**：仅当上游维护者否决 D1 的解释时启用（Open Questions 4）。
- **被否方案 B（纯 upstream PR，fork 不落地）**：国内商户侧 PSP 上游接受度未知，锚点客户 ERP tasks 3.2 排期等不起未知评审；且萬星产品面自身需要这些 provider。fork 落地 + 同步投递 upstream PR 双轨归化。
- **被否方案 C（Marketplace 远端面）**：与本地目录取交集，不能引入目录外 service；且商户凭证仍是本仓托管语义，不解决缺口。

### D2: 「TENANCY=off 字节兼容」的边界解释——租户行为 vs 目录组成

字节兼容条款的语境是 fork 的 **tenancy 实现**不得改变上游行为（auth/storage/MCP/console），本 change 零 tenancy 代码，两档行为逐字节一致。provider 目录是**数据面内容**：catalog 生成物本就 gitignored、各部署自行生成，fork 携带自己的 `src/providers` 组成本是分叉产品的应有之义。新增 provider 改变目录组成（1568 → 1570），不改变任何行为语义。「additive env-gated」由**既有 env 配置面**承担：`ConnectorRuntimeOptions.actionPolicy` / `allowedTriggers`（migration 0007/0016 已建）支持按 `<service>.*` 精确/通配阻断，不想要新 provider 的部署零代码收口——不新增 env、不新增门代码。

### D3: 支付渠道 provider 最小集与只读纪律

- `wechatpay`（微信支付商户平台 APIv3）：`custom_credential` = 商户号（mchid）、商户 API 证书私钥、证书序列号、APIv3 密钥、（可选）微信支付平台证书。action 首版全 read：**交易账单下载**（downloadbill 申请/下载语义）、**交易查询**。trigger：**支付结果通知**（webhook，receive 内验签 + 幂等）。
- `alipay`（开放平台）：`custom_credential` = appId、应用私钥、支付宝公钥（或公钥证书）、（可选）网关覆盖。action 全 read：**对账单下载**、**交易查询**。trigger：**异步通知回调记录**。
- 纪律：全 provider 零 write/destructive；`requiredScopes`/`providerPermissions` 用渠道原生口径（AGENTS.md：provider 原生 scopes）。
- 网络与共享 owner 纪律：egress 全走共享 SSRF-guarded fetch（`context.fetcher`，DNS 校验默认开）；签名用 `src/core/aws-sigv4.ts` 的 `sha256Hex`/`encodeRfc3986`（平台通用件），需要 `hmacHex` 时在上游模块导出而非本地复制；错误走 `providerInputError`/`providerResponseError`/`runProviderRequest`；通用读取走 `src/core/cast.ts`——零克隆类新增，clone-baseline 不动。API 域名（`api.mch.weixin.qq.com` 等）为代码字面量，是否 `skipDnsValidation` 按 AGENTS.md 口径在 PR 说明中显式给理由。
- **银联**不进首版（Open Questions 1）；确认后按本 decision 同构增补，无需改 spec 结构。

### D4: 回调记录挂既有 subscription 机制，零迁移

微信/支付宝 `notify_url` 指向部署公网入口（Open Flow ingress），回调经既有链路投递到本 provider trigger 的 `receive`；订阅落 `trigger_subscriptions`（migration 0017 已备，**无新迁移**——两种方言均无 schema 变更）；provider 实现只负责自身验签与输出归一。回调记录消费归 ERP 侧同源数据面。边界如实记录：公网入 口与事件调度归 Open Flow（`docs/runtime-api.md` §Provider Triggers），部署清单（publicOrigin + ingress + 回调域名白名单）为验收前置，商户资质由锚点客户/商户侧提供，ERP 线不代持。

### D5: 命名与上游 add/add 冲突处置

service id 取 `wechatpay`、`alipay`（`assertProviderId` 正则 `^[a-z0-9_-]+$` 通过；目录名 = service，生成器断言一致）。若上游未来新增同名 provider（add/add 冲突）：优先采纳上游实现并把连接语义差异映射过去；上游未覆盖商户侧只读面时保留 fork 版为唯一维护者并重启 upstream PR。归化 PR 提出时在描述中声明 fork 先行落地事实，请维护者优先评审以压低冲突窗口。

### D6: WMS 骨架裁定——框架先立、实现挂起

WMS 走 D1 同一载体；骨架契约 = 库存快照只读 action（库存查询/单据状态）+ 出入库事件 trigger（webhook 优先、不支持则 poll）+ 编排层零写面（pack.json：中台→WMS 单向写由客户既有链路承担）。**实现挂起条件**：锚点客户 WMS 品牌与接口形态确认。形态为中间表/文件交换等非 HTTP API 时，先出 SDK 能力缺口评估（现行 1568 provider 全为 HTTP 形态，`src/triggers` 亦无该形态先例），另立 change。验收判据先立档（spec scenarios）：「出库指令投递 → 作业完成事件回传 → 库存读对平」一轮闭环。

### D7: 金蝶增补评估结论与 upstream 增补项

- **可用性结论**（基于目录核验）：凭证推送（`save_record`/`draft_record`/`submit_records`/`audit_records` + `push_records` 下推链）、往来（应收/应付单 `query_records`/`save_record`/审核链 + `query_report` 对账数据源）、发票单据回写——经 12 个通用 formId action **可用但不保证够用**；前提是锚点客户星空实例预置对应单据转换规则（逐实例验证，属 ERP 线 tasks 3.1 接通验证，非本 change）。日终双边对账的计算在中台，连接器只供 query 面——无新增 action 需求；事件驱动本期以轮询满足——无新增 trigger 需求。
- **upstream 增补项清单**（按需提出、不预先虚构）：开票直连（税控/发票云）、凭证模板自动生成、银企直连。
- **本仓动作**：零代码。`src/providers/kingdee/**` 归上游，fork 复制同 service id 副本不可行（双周合并必冲突；生成器按目录名断言 service 唯一，同 id 双定义不可注册）；增补项以 upstream PR 另行提出，ERP 线挂账跟踪。

### 新增代码路径清单（design 规则：每条注明 fork-new / upstream-touched）

| 路径                                                               | 内容                                                           | 性质                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------- |
| `src/providers/wechatpay/definition.ts`                            | provider 元数据 + `custom_credential` 字段                     | fork-new（新路径）                |
| `src/providers/wechatpay/actions.ts`                               | 账单下载/交易查询 schema，全 read                              | fork-new                          |
| `src/providers/wechatpay/runtime.ts`                               | APIv3 签名、验签、分页、错误提取                               | fork-new                          |
| `src/providers/wechatpay/executors.ts`                             | 动作执行 + `credentialValidators` + `triggers`（支付结果通知） | fork-new                          |
| `src/providers/alipay/*`（同构四件）                               | 开放平台签名/验签、对账单/交易查询、异步通知 trigger           | fork-new                          |
| `catalog/apps/*.json`、`apps-index.json`、`registry*.generated.ts` | 生成物再生                                                     | generated（gitignored，非源文件） |
| **upstream-touched**                                               | **无**                                                         | —                                 |

无 schema 变更：两种方言（`migrations/` 与 `migrations/postgresql/`）均零新迁移，回调订阅落既有 `trigger_subscriptions`。

## Risks / Trade-offs

- **[硬约束解释风险：新目录位于 `src/providers/` 命名空间内]** → 裁定与证据在 D1；缓解：归化 PR 同步投递、下一个双周合并窗口与上游维护者确认解释；若被否，启用 overlay 回退预案（D1 方案 A，成本已备案）。
- **[上游同名 provider add/add]** → D5 处置顺序 + 归化 PR 优先评审压低窗口。
- **[渠道 API 资质依赖外部]** → 商户号/证书由锚点客户/商户侧提供（BYOK）；开发期用沙箱/测试商户，接通验证与 ERP tasks 3.1/3.2 对齐。
- **[回调入公网依赖部署面]** → D4 边界如实声明；验收前置部署清单（publicOrigin、Open Flow ingress、渠道回调域名白名单）。
- **[目录增长的启动成本]** → `lazySchemas` 默认 on + 索引增量两条 entry，量级可忽略；`catalog-index.test.ts` 回归兜底。
- **[渠道 API 无沙箱或沙箱覆盖不全]** → 账单/查询为只读面，测试环境实数据风险为零；executor 测试以 mock fetch 覆盖签名/验签/分页/错误路径。

## Migration Plan

无迁移。部署顺序：合并 → 启动自动再生目录（`ensure-generated`）→（可选）部署级 `actionPolicy`/`allowedTriggers` 收口 → 商户凭证经 `custom_credential` 录入（BYOK，凭证不出库）→ 建立 trigger 订阅。回滚：撤镜像即回到无新 provider 的目录；遗留连接因 provider 缺席不可达，`trigger_subscriptions` 残行由既有 maintenance 清理，无数据危害。

## Open Questions

1. 银联商户侧是否进入首版（锚点客户确认中；确认则按 D3 同构增补，spec 无需改结构）。
2. 锚点客户 WMS 品牌与接口形态（阻塞 D6 实现，不阻塞本 change；ERP 线挂账）。
3. 微信支付平台证书轮换自动化程度（首版手动配置平台证书 vs 调证书下载接口，实现时定）。
4. upstream 对国内商户侧 PSP provider 的接受度（归化 PR 提出后回填；否决则触发 D1 回退预案评估）。
