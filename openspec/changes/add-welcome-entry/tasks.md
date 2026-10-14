# Tasks

- [x] 1. 根路径导流（design D1）：`App` 组件在 locked 判定前插入
      `tenantMode && location.pathname === "/"` → `<Navigate to="/me" replace />`；
      管理台路由与 `TENANCY=off` 行为不变
- [x] 2. 欢迎卡加厚（design D2，`SignInCard`）：定位句（`signInIntro` 改写）+
      三步行 + 「了解产品」链接（`useLang()` 前缀 zh 选中文页，否则英文页，新标签）+
      安全承诺；登录按钮维持唯一入口
- [x] 3. 六语言文案键（design D3：en / zh-CN / zh-TW / ja / ru / fr）全配，
      `i18n.test.ts` parity 绿；`tenant-routing.test.ts` 手写 mock locale 补新键
- [x] 4. 测试（design D4）：`tenant-routing.test.ts` 增根路径导流断言 + off 档
      根路径仍出解锁面回归；`user-page.test.tsx` SignInCard 断言扩至三步行/
      链接/安全承诺 + `learnMoreUrl` 六语言选页断言。
      验证：lint 0 warn/0 error；typecheck 绿（registry 1568 up to date）；
      vitest 全量 3502 passed（2 个并发超时 flake——catalog-index/
      provider-abort，隔离复跑含本改动全过）；oxfmt 本 change 文件全绿
      （CONTEXT.md/openspec 主 spec 等 10 个预存 format 债已核查为基线问题、
      oxfmt 会改坏词条内容，回滚不入本 change）
- [ ] 5. 目检：本地实机走匿名根路径 / 匿名 `/me` / 登录回流三态，浏览器
     截图留证（重点：无壳闪烁或不可感）
- [ ] 6. 出片上线：commit → 镜像 → GitOps roll → 线上验收（匿名访问根路径
     到达欢迎卡；六语言文案在产物内；官网页「在线体验」按钮到达欢迎卡）
- [ ] 7. 归档
