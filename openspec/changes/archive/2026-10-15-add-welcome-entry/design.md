# Design — add-welcome-entry

## Context

见 proposal「Why」。事实锚点（2026-10-15 实证，HEAD `fd32a5f5`）：

- 根路径 `/` 由 SPA 前端路由决定渲染：服务端静态层把 `/` 重写为 `/index.html`（`src/server/api/static-routes.ts:25-27`），任何未知路径都回 fallback HTML（`static-routes.ts:57-79`）。**没有服务端路由层面的 `/` 处理**——现在匿名 `/` 显示解锁墙，纯粹是前端 `App` 组件的 `locked` 态渲染（`web/src/ui.tsx:310-312`：`if (locked) return <UnlockView/>`）。
- `mode` 判定已在壳层：`useTenantConfig()`（`web/src/user/use-tenant-config.ts`）返回 `undefined`（加载中）/ `null`（TENANCY=off）/`TenantConfig`（oidc）；`App` 已用 `tenantConfig?.mode === "oidc"` 计算 `tenantMode`（`ui.tsx:204-209`）并以此决定 `/me` 是否为用户面板。
- `/me` 未登录卡 = `SignInCard`（`web/src/user/user-page.tsx:103-114`）：品牌 + 一句 `userPanel.signInIntro` + 登录按钮（`window.location.assign("/api/tenant/oidc/authorize")`）。
- 六语言 locale：`web/src/locales/{en,zh-CN,zh-TW,ja,ru,fr}.json`；`web/src/i18n.test.ts` 断言非 en 键集与 en 完全相等 + 无空值 + 占位符形态。
- 服务端探针：生产 readiness = `GET /health`（`fd-infra-deploy/all-services/prod/open-connector-mt.yaml:127-128`），不经 `/`，导流不碰探针。
- 出片：`.github/workflows/publish-tcr.yml`（push main → hkccr `yizuo/open-connector-mt:sha-<7>` + `main`；hk→ccr 由 cheap-3 tcr-relay 回灌）；CI 门 = `.github/workflows/ci.yml`（oxlint+oxfmt → typecheck → vitest）。
- 路由测试前例：`web/src/tenant-routing.test.ts` 用 `renderToStaticMarkup` + `MemoryRouter` 渲染 `App`，mock `useTenantConfig`/`api`，断言 `/me` 无解锁墙、off 档隐藏用户面板——本 change 的断言直接扩此文件。

## Goals / Non-Goals

**Goals**：oidc 档根路径不再出解锁墙、导流 `/me`；欢迎卡带定位句/三步行/了解产品链接/安全承诺。
**Non-Goals**：不改服务端路由与探针；不动 off 档与 `/overview` 管理台解锁面；不做独立落地页；不改弹窗与跨域铸牌。

## Decisions

### D1 根路径导流 = 前端 `<Navigate>`，不做服务端 302

`App` 组件在 `locked` 判定**之前**插入：

```tsx
const onRootPath = location.pathname === "/";
...
if (tenantMode && onRootPath) return <Navigate to="/me" replace />;
```

- **为什么不是服务端 302**：`/` 现在根本不经过服务端路由（静态层直接回 index.html），加服务端分支要在 `static-routes.ts` 或 `index.ts` 里新增 fork 代码并让 config 视界穿透到静态层，触碰面更大、离上游更远；前端导流复刻既有 `/me` 判定链（`tenantMode && pathname`），一行条件，fork delta 最薄。
- **为什么不是"根路径渲染欢迎卡本体"**：会让 `/` 与 `/me` 两个 URL 渲染同一面且 URL 不统一（用户看到的地址栏与分享链接不一致）；`<Navigate replace>` 后地址栏归一到 `/me`，与"唯一的匿名面 = `/me`"决策（grill Q1-a）一致。
- `replace` 避免浏览器返回键在 `/` 与 `/me` 之间打乒乓。
- 加载态：`useTenantConfig()` 未决时 `tenantMode=false`，此时 `locked` 也为初始 `false`（首帧 `authenticated: true`）而根路径会短暂渲染管理台壳——这是既有行为（`/me` 同样先渲染壳再切换）。导流条件加不加 `undefined` 分支都会有一帧过渡；选择**不加**（保持条件最简），视觉上是 1 帧内的重定向，用户不可感。若目检发现明显闪烁，再在导流条件中并入 `tenantConfig !== undefined` 的重定向（实施期微调，不改变本决策的落点）。

### D2 欢迎卡加厚 = SignInCard 扩展

`SignInCard` 从「品牌 + 一句 + 按钮」扩为：

```
品牌（萬星连接器）
定位句（连一次账户…——userPanel.signInIntro 改写为与官网页 tagline 同口径）
三步行 <ol>（userPanel.stepSignIn / stepConnect / stepMint）
「了解产品」<a>（userPanel.learnMore → 按语言选官网页，新标签）
安全承诺一行（userPanel.securityNote）
登录按钮（视觉主 CTA，置底）
```

- 语言选页：`useLang()`（`@embra/i18n/react`，`LanguageSelect` 同款 hook，`ui.tsx:748-756`）以 `lang.startsWith("zh")` 判断 → `https://www.finddatatech.cloud/zh/products/wanxing-connector/`（zh-CN/zh-TW），否则 `/products/wanxing-connector/`。选 `useLang()` 而非 `navigator.language`：跟随界面语言（用户切 en 后链接指英文页）。
- 登录按钮的 `window.location.assign("/api/tenant/oidc/authorize")` 不动（弹窗/回调链零触碰）。
- 口径与官网页同源（下限：1500+ 服务、万级动作；凭据加密、执行面不对公网）；文案收短，细节留在官网页。

### D3 六语言键

新增键（六语言全配）：`userPanel.stepSignIn`、`userPanel.stepConnect`、`userPanel.stepMint`、`userPanel.learnMore`、`userPanel.securityNote`；`userPanel.signInIntro` 改写为定位口径。en 真源 + 五语言翻译由 `i18n.test.ts` 键集 parity 兜底。

### D4 测试

`tenant-routing.test.ts` 增两条：oidc 档根路径渲染 `Navigate` 效果（`renderApp("/")` 产出与 `/me` 相同、不含 `unlock-screen`）；off 档根路径仍出管理台解锁面（回归）。`user-page.test.tsx` 的 SignInCard 断言扩至三步行/链接/安全承诺（含 zh 档链接指向 `/zh/` 页）。加 `tenant-routing.test.ts` 的 locales mock 需补新键（mock locale 树是手写的，键缺失即 t() 回退键名，断言会看到差异——实施时同步补）。

## Risks / Trade-offs

- [一帧壳闪烁]（D1 加载态）→ 目检确认；不可感则接受，可感则按 D1 括号内微调。
- [新键使 tenant-routing 测试的手写 mock locale 漂移] → D4 已列为实施动作；CI 的键集 parity 测试只覆盖真实 locale 文件，mock 需人工同步（既有模式，前例 likewise）。
- [「了解产品」链接硬编码官网页 URL] → 官网域是产品域名（www.finddatatech.cloud），非部署相关量；与「打开连接器控制台不硬编码域名」纪律不冲突（那条针对部署基线，这条是产品官网）。若未来官网路径变更需同步此常量——接受（单点常量）。
- [管理台直达路径的用户找不到门] → 管理员群体经直连 `/overview` 与 `/me` 面板「返回管理台」（可证 admin 才显示）两条路，且 `/me` 已保留此链（`tenant-console` spec 现状）；grill Q1 已弃「落地加管理员小链接」。

## Migration Plan

常规出片：commit → `publish-tcr.yml`（auto on push main）→ hkccr → tcr-relay → ccr → fd-infra-deploy bump `open-connector-mt.yaml` image tag → ArgoCD（all-services-prod）滚动。无迁移、无 env、无 DB。回滚 = revert 提交 + bump 回前一 sha。探针不受影响（`/health` 不变）。

## Open Questions

（无）
