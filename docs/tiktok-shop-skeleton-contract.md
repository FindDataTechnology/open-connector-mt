# TikTok Shop 接入骨架契约（实现挂起）

状态：**骨架先行，实现挂起**。11-03 裁决把 TikTok Shop 定为跨境首发授权通道，
但截至 2026-11-10 仓内只有文案、没有 provider（`grep -ri tiktok` 仅命中
`fd-appliance/tenants/crossborder/sources-tiers.json:48` 一句）。本文把动作面与
验收判据先钉死，实现按锚点客户落地（ADR 0002：不为想象的接口写 provider）。

消费方：`fd-erp-vertical-templates` 的 `connectors/tiktok_shop.py`（已就位，经连接器
运行时调用 `tiktok_shop.*`；未接通时 `NOT_WIRED` 且说明「待商家授权 + 平台应用审核」）。

## 载体

- `src/providers/tiktok_shop/`（definition / actions / executors / runtime）；
- 端点一律代码字面量，禁止从凭证或入参取 base URL（ADR 0002 理由 1）；
- 区域站点（US / UK / SEA 等）差异走**配置项**（站点代码），不复制 provider。

## 凭证形态

- OAuth（Partner Center 应用 app_key + app_secret 换取 access_token + shop_cipher）；
- access_token 有效期短，**refresh 由 provider 侧完成**，模板层不接触 app_secret；
- 授权失败一律 401/403 由运行时透出为 `AUTH_FAILED`，不降级成空数据。

## 动作面骨架（全部 `operationType=read`）

1. `list_orders`：按店铺 + 时间窗拉订单（订单号、下单时间、金额、币种、状态、退款标记），
   支持游标分页与按 `update_time` 增量。
2. `list_settlements`：结算/账单（账期、应结、扣费、实结）。**与订单面是两个面**：
   佣金、平台补贴、运费险只在结算侧，不能由订单加总推出。
3. `list_inventory`：SKU 维库存（可用量、锁定、在途）。
4. `get_shop`：店铺 id、站点、币种、账期口径。

频控：按站点令牌桶；触发限流返回 429，由运行时映射 `RATE_LIMITED`（报数归因「配额」，
不是「无数据」）。

## 验收判据（一轮闭环）

> 账期结算单读回 → 与订单面交叉验证 → 差额可解释

1. 某账期 `list_settlements` 合计 = 该账期 `list_orders` 合计 − 平台扣费 − 退款 + 补贴，
   差额为零或可逐项归因；
2. 同一 `update_time` 窗口重复拉取幂等（`stable_id` 集合一致）；
3. 翻页到 `hasNextPage=false` 才算读完（单页读取不得当作全量）。

## 矩阵与对外口径

- 动作未实现前：`capability-matrix.json` 里 `tiktok_shop.*` 全部保持 `unmapped`，
  原因写「通道未实现」，对外说「需一次接入」；
- 动作落地但未真实读取：仍 `unmapped`，原因改「动作已落地，缺真实读取记录」；
- 完成一次真实读取并留痕后，才允许升 `available`（证据两半缺一不算）。

## 前置依赖（挂账）

- 平台应用审核通过 + 至少一家锚点商家授权；
- 站点与结算币种口径确认后，才补齐 `settlements` 的字段映射。
