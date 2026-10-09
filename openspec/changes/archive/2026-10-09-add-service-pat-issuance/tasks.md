## 1. 铸造端点扩展（触碰上游文件 connect-server.ts）

- [x] 1.1 `createRuntimeToken`（`src/server/connect-server.ts`，**上游文件**）接受可选 `kind`：仅 `"service_pat"` 通过，其余值（含 user_pat、非字符串）400 `invalid_input` 并说明只支持 service_pat；未指定时行为不变（不传第三参）；同步 `src/server/api/openapi.ts` 的 `RuntimeTokenCreateRequest` 增加 `kind` 枚举字段（仅 `"service_pat"`，可选）；验证：新增 route 测试覆盖三种输入（无 kind / service_pat / user_pat 拒绝）
- [x] 1.2 铸造 `service_pat` 时不传 `tenantId`，断言响应 `record.kind === "service_pat"` 且 `record.tenantId` 为空；验证：同上测试断言
- [x] 1.3 `TENANCY=off` 回归：跑既有 runtime-token 相关测试套件，确认无 kind 路径逐字节不变；验证：`npx vitest run src/server/connect-server.test.ts` 全绿
- [x] 1.4 admin 域撤销清 consent（D5）：`revokeRuntimeToken` 在 `tenantAuth` 装配时补 `tenantStore.revokeConsentsForToken(id)`，off 档（hooks 未装配）不触碰；验证：route 测试断言 grant 后 DELETE → `hasConsent` 为 false，且既有撤销测试（无 hooks）不变

## 2. 消费链验证（service_pat + actor 头）

- [x] 2.1 route 级测试：admin 铸造 service_pat → 以 `Authorization: Bearer <pat>` + `x-oo-connector-actor-sub: <已登记 sub>` 调 `/mcp` tools/list → 以 actor 租户返回；验证：新测试断言返回的连接属于 actor 租户（实现为组合覆盖：端点铸造在 connect-server.test.ts、中间件消费链在 tenant-auth.test.ts——断言 `currentStoreTenant()`=actor 租户且只见该租户连接；真 `/mcp` tools/list 全链由 4.1 smoke 承担）
- [x] 2.2 撤销即时生效：撤销后同一请求 401；验证：同测试文件断言
- [x] 2.3 `SERVICE_OBO=off` 下同请求 401（resolver 返回 undefined，与匿名同形）、actor 未登记 401、user_pat 带头仍以自身租户执行；403 仅适用 admin 域（2.4）；验证：矩阵测试（可与既有 OBO 测试合并）
- [x] 2.4 service_pat 不可达 admin 域：以 service_pat 请求 `/api/providers` → 403；验证：同测试文件断言

## 3. 面板与文档

- [x] 3.1 运行时令牌页显示 `kind` 标识（legacy / user_pat / service_pat），创建表单加"服务主体"选项（默认空 = legacy）；`web/src/model.ts` 的 `RuntimeTokenSummary` 类型补 `kind`/`tenantId` 字段；验证：console 测试或手工冒烟记录（web tsc 干净 + web 测试 191 绿；i18n 六语言齐全）
- [x] 3.2 README / 接入指南写明谦面式调用契约：`Authorization: Bearer <service_pat>` + `x-oo-connector-actor-sub`，及 `SERVICE_OBO` 三档行为差异；actor sub = 用户统一登录 sub（同 Logto，未在 connector 登录过的用户需先完成一次 OIDC 登录，否则代调被拒不自动建身份）；facet 侧装配（PAT 进 agent 服务运行时）为谦面仓另行工作，不在本 change；验证：文档落盘并人工复核（docs/runtime-api.md 新增 "Service PATs and on-behalf-of access (multi-tenant)" 节）

## 4. 冒烟与收尾

- [x] 4.1 `scripts/mt-smoke.mjs` 增加 service_pat 段：admin 铸造 → actor 头调用 → 撤销 → 401（沿用既有 stub IdP 与真实服务器）；验证：`node scripts/mt-smoke.mjs` SMOKE PASS 且新 ok 行出现（8 行：铸造/kind 投影、user_pat 400、无 actor 401、未知 actor 401、actor=alice tools/call 200、actor=bob 200、admin 域 403、撤销 401；正向租户数据隔离在 tenant-auth.test.ts 中间件层以真库断言——no_auth 虚拟连接全员可见、api_key 创建走活校验，目录级标记分不开租户）
- [x] 4.2 全量门：lint + format + typecheck + 单测 + 冒烟全绿；验证：记录命令与结果（oxlint 0 警告；oxfmt root+web 全净；typecheck src/scripts/examples + web tsc 干净；vitest 全量 3471 passed；web 测试 191 passed；openspec validate 绿）
- [x] 4.3 上线 fd-prod（前置：环境设 `SERVICE_OBO=allow-all` 并重启，见 design D7）并以真 actor 身份跑一次代调（记录 run 的 tenant_id 与 actor 审计字段）；验证：pod 内 DB 查询 runs 表
——**2026-10-09 生产实证**：sha-069625a 滚动；admin 铸 service_pat（kind=service_pat、tenantId=null、明文一次性）；actor=r80b1gx744mq（doc-studio，已登记身份）头下 tools/list 200 且只见 actor 租户连接；execute_action appledb.get_device 到达 provider（上游 ETIMEDOUT 不影响链路判定），runs 表实落两行：tenant_id=actor 租户 e6109763…、value.runtimeTokenId=该 service_pat id（e6de7375…）——service/actor 双审计实证；撤销后同请求 401。
