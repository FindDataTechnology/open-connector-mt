# add-supply-chain-provider-onboarding — tasks

> 触碰声明：本 change **零上游既有文件改动**（design D1；upstream-touched = 无）。下列所有代码任务落点均为 `src/providers/` 下 fork-new 新路径；生成物任务只再生 gitignored 生成数据。每组任务独立可验证。
>
> 实施注记（2026-11-07）：`npm run format` 全仓 check 在本仓基线（不含本 change）即对 10 个上游既有 markdown/yaml 文件报红（上游 oxfmt 版本漂移所致，干净树核验同样报红）。为守住零触碰，本 change 未执行全仓 `format:fix`；本 change 全部新文件经 oxfmt 检查零 diff，lint/typecheck/vitest 独立全绿。另：全量 vitest 中 `src/oauth/oauth-flow-service.test.ts` 1 例失败为**基线既有**（硬编码过期时间 2026-10-30 相对今日已过期的 time-bomb，干净树核验同样失败），与本 change 无关，归上游修复。

## 1. 载体裁定落档（本 change 工件面）

- [x] 1.1 四件工件定稿，`openspec validate add-supply-chain-provider-onboarding --strict` 绿；全程客户中性（锚点客户口径）
- [ ] 1.2 在下一个上游双周合并窗口与维护者确认 D1 解释（新目录 = additive，非「modify」）；结论回填 design Open Questions 4，否决则启动回退预案评估（D1 方案 A），本任务不阻塞 2/3 组开发

## 2. wechatpay provider（独立可验证）

- [x] 2.1 `src/providers/wechatpay/definition.ts`（fork-new）：provider 元数据（官方 homepageUrl、原生权限口径）+ `custom_credential` 6 字段（mchid、商户 API 证书私钥、证书序列号、APIv3 密钥、可选平台证书），帮助文案指向官方商户平台指引
- [x] 2.2 `src/providers/wechatpay/actions.ts` + `runtime.ts`（fork-new）：交易账单下载、交易查询，全部 `operationType=read`；实施注记：APIv3 请求签名为 RSA-SHA256（`node:crypto`），无需 `aws-sigv4.ts` 的 `sha256Hex`/`encodeRfc3986`/`hmacHex`，未引入该依赖即满足共享 owner 纪律；错误/超时走 `provider-runtime.ts` 共享 owner（`ProviderRequestError`/`providerInputError`/guarded fetch/`readBoundedResponseBytes`）；egress 走 `context.fetcher`，`skipDnsValidation=true` 理由：全部请求域名（含账单下载域，运行时强制校验同名 host）为代码字面量 `api.mch.weixin.qq.com`，沿 stripe 硬编码域名先例，URL/redirect guard 仍生效（理由同时落在 executors.ts 代码注释与归化 PR 描述）
- [x] 2.3 `src/providers/wechatpay/executors.ts`（fork-new）：动作 executor + `credentialValidators` + 支付结果通知 trigger（webhook：`receive` 内自验签 + 幂等；`reconcile` 以 `GET /v3/certificates` 验活），经 `ExecutorModule.triggers` 注册；回调验签密钥为公开的平台证书，落订阅 config（非机密、fail-closed），APIv3 密钥等机密仍仅存加密连接、不进订阅；proxy 限读路径白名单（certificates/bill/transactions/fund），无资金写面
- [x] 2.4 provider 本地测试（fork-new，非上游迁移故须测试）：executor mock fetch 切片（签名正反例、账单分页、错误映射）+ trigger 验签正反例（executors 13 例 + trigger 10 例）；跑 `UPDATE_CLONE_BASELINE` 检查确认零新增克隆条目（首轮曾有 4 处命中 `providerInputError` 共享 owner，已改为调用共享 owner 后 ratchet 全绿）
- [x] 2.5 验证：`npm run generate:catalog` 幂等（二次运行零 diff，全目录 SHA-256 前后一致）；lint 0 warning 0 error、typecheck 绿、vitest 相关切片绿（全量 vitest 唯一失败为基线既有 time-bomb，见卷首注记）、`npm run format` 本 change 文件零 diff；`git status` 确认生成物（catalog/、registry\*.generated.ts）不入库、上游源文件零改动

## 3. alipay provider（独立可验证）

- [x] 3.1 `src/providers/alipay/definition.ts`（fork-new）：appId、应用私钥、支付宝公钥（或公钥证书）、可选网关覆盖的 `custom_credential` 面，帮助文案指向开放平台指引（首版公钥模式；公钥证书模式挂账 Open Questions）
- [x] 3.2 `src/providers/alipay/actions.ts` + `runtime.ts`（fork-new）：对账单下载、交易查询，全部 `operationType=read`；开放平台 RSA2 签名/验签同 2.2 的共享 owner 纪律；响应验签按官方 SDK 语义（原始响应节点文本，非重序列化）；网关可由凭证配置故 DNS 校验保持开启（`assertPublicHttpUrl` 校验网关与账单下载 URL）
- [x] 3.3 `src/providers/alipay/executors.ts`（fork-new）：动作 executor + validators + 异步通知回调记录 trigger（同 2.3 机制）；alipay 异步通知为 form 编码而运行时 webhook 面只收 JSON，公网入口需将 form 字段转 JSON 对象投递（触发器描述与 trigger-permissions 已如实声明该部署前置）；proxy 方法白名单（trade.query / fastpay.refund.query / bill.downloadurl.query）——退款域只含查询、无资金写面
- [x] 3.4 provider 本地测试（同 2.4 口径：签名正反例、对账单下载、验签正反例；零克隆条目确认）（executors 13 例 + trigger 11 例）
- [x] 3.5 验证（同 2.5：生成幂等、vitest、生成物不入库）

## 4. 收口与跨面验收

- [x] 4.1 目录核对：`catalog/apps/` 恰新增 2 文件（alipay.json、wechatpay.json），`apps-index.json` 一致，全目录 SHA-256 再生前后一致（生成器幂等性回归；catalog 为 gitignored 生成数据，以整目录哈希对比替代逐文件 diff）；index 计数 1570（providers 1568 → 1570，actions 18345 → 18349）
- [x] 4.2 只读纪律核对：两 provider 全 action `operationType=read`（catalog 实测各 2 action 全 read、零 `write`/`destructive`）；trigger 面仅支付回调（`wechatpay.payment_notify`、`alipay.trade_notify`）；部署级收口演练已完成：本地 `TENANCY=off` 启动 + `OOMOL_CONNECT_BLOCKED_ACTIONS=wechatpay.*`，`/v1/providers` 目录面如实可见（1570 家、含 schema），`POST /v1/actions/wechatpay.query_transaction` 返回 `action_blocked`（HTTP 400、audit 落库），对照组 alipay 未受阻断（纯配置零代码，已核）
- [ ] 4.3 回调链路验收（锚点客户沙箱/测试商户）：一笔真实支付回调经订阅落 `trigger_subscriptions`、验签通过；伪造签名被拒；connection 断开时订阅按既有语义拒绝/清理（无新迁移，0017 已备）——**挂账**：无真实商户凭证（mchid/API 证书/APIv3 密钥由锚点客户/商户侧提供，BYOK），验签/幂等/拒收语义已由本地 trigger 测试以测试密钥对覆盖（wechatpay 10 例、alipay 11 例，含伪造签名拒收、重放超窗拒收、无证 fail-closed），live 回调验收待商户资质到位后与 ERP tasks 3.1/3.2 对齐执行；部署前置：publicOrigin + Open Flow ingress + 渠道回调域名白名单（design D4 边界）
- [x] 4.4 upstream 触碰终审：`git status --porcelain` 对照基线，tracked 文件改动为 **0**（实施中曾因全仓 `format:fix` 误格式化 10 个上游 markdown/yaml，已当场 `git checkout` 全量还原并改用仅对本 change 文件的格式检查）；新增仅 `src/providers/wechatpay/`、`src/providers/alipay/`（fork-new）、`docs/wms-skeleton-contract.md`（fork-new）、`openspec/changes/add-supply-chain-provider-onboarding/`（本 change 工件）；`src/providers/kingdee/**`、生成器脚本、`connector-runtime.ts`、migrations 零改动（零新迁移，回调订阅复用既有 `trigger_subscriptions`）
- [ ] 4.5 挂账回填：银联首版与否（Open Questions 1）、WMS 品牌与接口形态（Open Questions 2）、金蝶 upstream 增补项清单同步 ERP 线（`fd-erp-vertical-templates` connector-onboarding 文档 §1.3/§2.5 消费）——**挂账**：三项均依赖锚点客户确认/ERP 线消费，属跨线跟踪项；WMS 骨架契约已落档 `docs/wms-skeleton-contract.md`（骨架、验收判据、形态分支、前置依赖），金蝶增补评估结论在 design D7、upstream 增补项清单（开票直连/凭证模板自动生成/银企直连）已列，待 ERP 线挂账同步
