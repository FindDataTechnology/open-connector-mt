# Design — add-catalog-read-surface

## D1 为什么不放宽 `service_pat` 的无 actor 档（被否决的选项 A）

最直觉的修法是让 `resolveServicePat` 在没有 actor 头时返回一个「无租户的只读主体」，这样谦面用现成的 `service_pat` 就能读 `catalog-coverage`。否决理由：

- `resolveServicePat`（`src/server/tenancy/tenant-auth.ts:209-235`）是 **OBO、consent、租户解析、令牌归属** 的汇合点，四件事共用一条路径。给它加「无 actor 时放行」等于给这条路径加第二个语义分支，而这条路径上任何一处松懈都会影响所有租户面端点。
- 「无租户主体」一旦存在，它读什么由每个端点自己决定。今天只有目录是租户无关的，明天新增端点时没有任何机制阻止它在无租户主体下返回租户数据——**约束会依赖每个 handler 的自觉**，而本仓已经有 `requireUser` 这个统一门来说明「自觉不可靠」。
- 与上游可合并性冲突：上游没有服务身份概念，这条分支会永久成为 merge 冲突面。

## D2 新增独立只读面 + 专用凭据（采纳）

形态：`src/server/catalog-routes.ts`（**fork-new**）导出一个 `registerCatalogRoutes(app, options)`，由 `connect-server.ts` 在**配置启用时**调用一次。

```ts
// 挂载点（connect-server.ts，upstream-touched：一行 import + 一段 if）
const catalogRead = readCatalogReadConfig(); // fork-new 读取函数
if (catalogRead.mode !== "off") {
  registerCatalogRoutes(app, { mode: catalogRead.mode, token: catalogRead.token, catalog: this.options.catalog });
}
```

三条纪律：

1. **默认不注册**。`mode === "off"` 时连路由都不存在，因此 `isPublicPath()` / `readAuthScope()` 一行都不用改——未启用部署的行为与上游逐字节一致。
2. **门在 handler 里**，不借道认证中间件。这样 admin/runtime 令牌不会因为中间件放行而意外获得本面能力（中间件的域判定是「路径前缀 ⇒ 某域」，把 `/api/catalog/*` 塞进任何一域都会顺带扩权）。
3. **常量时间比较**：令牌比较用 `timingSafeEqual`（等长后比较），与仓内既有凭据处理一致；不用 `===`。

配置读取放在 `src/server/tenancy/constants.ts` 旁新增的 fork-new 模块（`src/server/catalog-read-config.ts`），形状照 `readTenancyConfig`：纯函数、入参是 env 快照、返回值是 `{mode: "off"|"public"|"service", token?: string}`，非法取值直接抛错（启动期失败优于静默降级）。

**为什么是两枚令牌而不是一枚「目录令牌」挂在 runtime 域**：runtime 令牌同时开 `/v1/actions/:id` 的**执行**面（`canUseAdminAuth` 只对 POST `/v1/actions/*` 放 admin，runtime 域本身可读可执行）。把目录读写进 runtime 域等于「为了读目录，把执行权也交出去」。专用令牌只开本面，权限面最小。

## D3 覆盖度复用同一计算，不复制

`/api/tenant/catalog-coverage` 的计算（`tenant-routes.ts:644-680`）是三行：按 `operationType` 过滤 provider 的 actions、数 `locallyExecutable`、`covered = executableActionCount > 0`。本面**不复制**这三行，而是把它抽成 fork-new 纯函数 `coverageOf(provider, operations)`（放 `src/server/catalog-coverage.ts`），两处都调它。

理由不是洁癖：覆盖度是**声明窄面纪律的判据**，壹座侧据此判 `unwired`、谦面侧据此判「目录里有没有这个能力」。两份近似实现一旦差一格（比如一边算了 `destructive` 一边没算），同一个包在设置页说「支持」、在市场上说「不支持」，而这种分叉没有任何测试会红。抽函数顺带让「同口径」有一个可断言的落点。

`tenant-routes.ts` 因这次抽取要动一行（把内联计算换成调用）——**这属于本变更唯一一处对既有租户端点的修改**，语义不变，且由 D3 的等价用例钉住。

## D4 返回体：只放目录事实

端点：

| 方法 | 路径                                                    | 内容                                                                                      |
| ---- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| GET  | `/api/catalog/providers`                                | provider 列表（service / displayName / categories / authTypes / actionCount）             |
| GET  | `/api/catalog/providers/:service`                       | 单 provider 元数据（不含凭证与连接）                                                      |
| GET  | `/api/catalog/coverage?provider=&operations=read,write` | `{provider, operations:[{operation, covered, actionCount, executableActionCount}], gaps}` |
| GET  | `/api/catalog/actions/:actionId`                        | `{actionId, provider, operationType, executable}`                                         |

`/api/catalog/actions/:actionId` 只回答「这个 id 属于谁、是不是可执行」，**不返回** input schema、指南正文或任何运行时策略判定。原因：`scope-explain` 的 `allowed` 是**策略**答案（与部署的 actionPolicy 有关），那属于运行时面；目录面只回答目录事实。把两者混成一个端点会让「目录里有没有」与「这台机器允不允许」在消费方再次混为一谈——而这正是本变更想消掉的混淆。

## D5 上游 PR：不投递

上游（oomol-lab/open-connector）没有多租户消费方，也没有「第三方服务读目录」这个需求；公开目录面是 fork 的产品决定（为谦面/壹座的声明对账服务）。投递会被拒且把分歧永久留在 PR 历史里。因此本变更的上游可合并性目标是**薄**，不是**可归化**：新增文件为主，`connect-server.ts` 一处 if 块，双周合并时冲突面固定且已知。

## D6 兼容性矩阵

| 部署配置                       | 本面          | 既有面                             |
| ------------------------------ | ------------- | ---------------------------------- |
| 未设置（默认，含所有上游用户） | 不存在（404） | 逐字节不变                         |
| `public`                       | 匿名可读      | 不变                               |
| `service` + 令牌               | 需专用 Bearer | 不变；admin/runtime 令牌在此面 401 |
| `service` 无令牌               | 启动失败      | —                                  |
| 非法取值                       | 启动失败      | —                                  |

`TENANCY=off` 与 `TENANCY=oidc` 对本面无差别：本面一次都不读 `tenantStore`。

## D7 迁移

无 schema 变更，两种方言（sqlite / postgresql）都无迁移。日志中新增一行启动期声明（`catalog read surface: off|public|service`），便于运维确认开没开——这一行是**配置事实**，不泄露目录内容。

## 落点与归属

| 文件                                  | 性质                 | 改动                                            |
| ------------------------------------- | -------------------- | ----------------------------------------------- |
| `src/server/catalog-routes.ts`        | fork-new             | 四个只读端点 + 模式门                           |
| `src/server/catalog-coverage.ts`      | fork-new             | `coverageOf()` 纯函数（唯一口径）               |
| `src/server/catalog-read-config.ts`   | fork-new             | env 读取与校验（非法即抛）                      |
| `src/server/tenancy/tenant-routes.ts` | **upstream-touched** | 内联覆盖度计算换成调用 `coverageOf()`（一行级） |
| `src/server/connect-server.ts`        | **upstream-touched** | 一行 import + 一段条件挂载 + 一行启动日志       |
| `docs/runtime-api.md`                 | fork-touched         | 增一节：存在条件、两种模式、形状、绝不返回什么  |

## 测试计划

- `src/server/catalog-read-config.test.ts`（fork-new）：四档取值（未设置 / public / service+令牌 / 非法）与 service 缺令牌的启动失败。
- `src/server/catalog-routes.test.ts`（fork-new）：未启用 404、public 匿名 200、service 缺令牌 401、admin/api runtime 令牌 401、正确令牌 200、写动词 405、未知 provider 404 `unknown_provider`。
- **口径等价用例**：对 5 个真实 provider（含一个 `write` 不covered 的）逐字段比对 `/api/catalog/coverage` 与 `/api/tenant/catalog-coverage`。先把 `coverageOf` 抽出前后跑一次，证明等价；再故意改 `covered` 的判据，证明该用例能红。
- **泄漏用例**：把覆盖度与详情响应序列化后断言不含 `connection`/`tenant`/`pat`/`run`/`secret` 键（含嵌套键名扫描），并断言同一 provider 对两个不同令牌主体的响应逐字节相等。
- 全量 vitest + `npm run fix-check`。
