# add-user-panel-return-and-picker — Tasks

## 1. admin 探测与回程链接

- [x] 1.1 UserPanelShell 挂载时并行探测 `GET /api/auth/session`（同源 cookie），`adminAuthConfigured === true && authenticated === true` 时顶栏渲染「返回管理台」`<Link to="/overview">`；探测失败/非 admin 静默不渲染。验证：vitest 静态渲染断言两态（mock fetch 探测结果 true/false）——true 渲染链接、false 无链接节点。
- [x] 1.2 处理未配置 admin token 的部署：`adminAuthConfigured === false` 时不渲染链接（即使 authenticated 恒 true）。验证：断言 `adminAuthConfigured=false, authenticated=true` 组合不渲染。

## 2. provider 搜索选择器

- [x] 2.1 ConnectionsCard provider 字段改为「选择提供商」按钮 + Dialog 弹层：受控搜索框（displayName/service id 大小写不敏感子串匹配）、列表渲染前 50 条匹配并显示「共 X 条匹配」、行内 displayName + service id + OAuth 徽章、点击回填并关闭。验证：vitest 断言弹层结构（搜索框、截断行数、匹配计数、选中回填）。
- [x] 2.2 选择器数据源过滤 `authTypes ∩ {api_key, oauth2} ≠ ∅`（排除仅 no_auth provider）。验证：构造仅 no_auth provider 的 fixtures，断言其不出现在弹层结果。
- [x] 2.3 移除 authType 的 no_auth SelectItem 与 `create()` 的 no_auth 分支；选中 provider 后 OAuth 选项随 `supportsOAuth` 联动不变。验证：断言 authType 选项集不含 no_auth、api_key 直传 `{apiKey}`。

## 3. 文案与 i18n

- [x] 3.1 新增 locale 键（backToAdmin / pickProvider / searchPlaceholder / matchCount / oauthCapable）六语言全配。验证：既有 i18n 键完整性测试全绿（六语言无缺键）。

## 4. 验收门

- [x] 4.1 全量 vitest 绿（含既有 user-page 测试无回归）；`web/` 构建通过。
- [x] 4.2 用户浏览器一眼验收（真账号 `aloadtree@gmail.com`，2026-10-11）：解锁管理台后侧边栏「我的连接」→ /me 顶栏出现「返回管理台」→ 点击回到 `/overview` 且管理台仍解锁（侧边栏与概览数据在）；`POST /api/auth/logout` 后再开 /me，顶栏无该链接（反向用例实证）。选择器弹层打开正常、搜 `github` 过滤到 1 条并显示「支持 OAuth」标记。
- [x] 4.3 验收抓到的缺陷并修复：`tenant.connections.matchCount` 六语言写成单括号 `{count}`，而 `@embra/i18n` 只插值 `{{name}}`——页面渲染出字面量「共 {count} 条匹配」。已改六语言，并在 `i18n.test.ts` 加"禁止单括号占位符"断言（en 也覆盖）；回测确认该断言会红（2 处失败）后还原。
- [ ] 4.4 遗留（人工，需真 provider 凭据）：新增表单搜索选定 provider 后走通 API key 新增。

## 6. 测试基建（验收连带发现）

- [x] 6.1 `vitest.config.ts` 的 include 只有 `.test.ts`，`web/src/**/*.test.tsx` 被静默跳过——`user-page.test.tsx` 写了却从未执行，全量绿是假绿。已补 `.tsx` glob，全量测试数 3479 → 3491。

## 5. 部署

- [x] 5.1 出片与滚动：scs001 快照 `d4a4255`（真 sha 5faabe3 content）→ GHA Publish TCR Image 2m27s → cheap-3 relay 回灌 `OK yizuo/open-connector-mt:sha-d4a4255` → skopeo 实证 ccr digest `sha256:a4b6b90b` → GitOps `c9f258f` 推 gitee → ArgoCD 同步 → rollout 成功（pod `69c9854c5d-g5dmx`）。
- [x] 5.2 in-pod 实证：`/app/dist/web/assets/index-BYDOtF7g.js` 含四标记（Back to admin console / Choose provider / Recent runs / Wanxing Connector）；线上 health 200、`/me` 200、`/api/tenant/runs` 匿名 401（鉴权门生效）。
