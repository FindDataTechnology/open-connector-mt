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
- [ ] 4.2 用户浏览器一眼验收（人工）：管理台解锁后从侧边栏点「我的连接」→ /me 顶栏出现「返回管理台」→ 点击回到已解锁管理台；普通租户（无 admin cookie 浏览器）顶栏无该链接；新增表单搜索选定 provider 走通 API key 新增。
