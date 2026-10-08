## 1. 铸造端点扩展（触碰上游文件 connect-server.ts）

- [ ] 1.1 `createRuntimeToken`（`src/server/connect-server.ts`，**上游文件**）接受可选 `kind`：仅 `"service_pat"` 通过，其余值 400 `invalid_input` 并说明只支持 service_pat；未指定时行为不变（不传第三参）；验证：新增 route 测试覆盖三种输入（无 kind / service_pat / user_pat 拒绝）
- [ ] 1.2 铸造 `service_pat` 时不传 `tenantId`，断言响应 `record.kind === "service_pat"` 且 `record.tenantId` 为空；验证：同上测试断言
- [ ] 1.3 `TENANCY=off` 回归：跑既有 runtime-token 相关测试套件，确认无 kind 路径逐字节不变；验证：`npx vitest run src/server/connect-server.test.ts` 全绿

## 2. 消费链验证（service_pat + actor 头）

- [ ] 2.1 route 级测试：admin 铸造 service_pat → 以 `Authorization: Bearer <pat>` + `x-oo-connector-actor-sub: <已登记 sub>` 调 `/mcp` tools/list → 以 actor 租户返回；验证：新测试断言返回的连接属于 actor 租户
- [ ] 2.2 撤销即时生效：撤销后同一请求 401；验证：同测试文件断言
- [ ] 2.3 `SERVICE_OBO=off` 下同请求 403、actor 未登记 403、user_pat 带头仍以自身租户执行；验证：矩阵测试（可与既有 OBO 测试合并）
- [ ] 2.4 service_pat 不可达 admin 域：以 service_pat 请求 `/api/providers` → 403；验证：同测试文件断言

## 3. 面板与文档

- [ ] 3.1 运行时令牌页显示 `kind` 标识（legacy / user_pat / service_pat），使 operator 能区分；验证：console 测试或手工冒烟记录
- [ ] 3.2 README / 接入指南写明谦面式调用契约：`Authorization: Bearer <service_pat>` + `x-oo-connector-actor-sub`，及 `SERVICE_OBO` 三档行为差异；验证：文档落盘并人工复核

## 4. 冒烟与收尾

- [ ] 4.1 `scripts/mt-smoke.mjs` 增加 service_pat 段：admin 铸造 → actor 头调用 → 撤销 → 401（沿用既有 stub IdP 与真实服务器）；验证：`node scripts/mt-smoke.mjs` SMOKE PASS 且新 ok 行出现
- [ ] 4.2 全量门：lint + format + typecheck + 单测 + 冒烟全绿；验证：记录命令与结果
- [ ] 4.3 上线 fd-prod 并以真 actor 身份跑一次代调（记录 run 的 tenant_id 与 actor 审计字段）；验证：pod 内 DB 查询 runs 表
