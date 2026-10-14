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
- [x] 5. 目检：本地实机走匿名根路径 / 匿名 `/me` / 登录回流三态，浏览器
     截图留证（重点：无壳闪烁或不可感）。
     证据：vite dev(:5273)+API stub 三态——匿名 `/` → `/me` 欢迎卡六要素齐列
     （截图）；stub 切会话后 `/` → `/me`「我的连接」面板；localStorage 语言
     偏好切 en 后 html lang=en、链接文本 "Learn more"、href 指英文页；
     无解锁墙、无壳闪烁（导流在首帧完成）
- [x] 6. 出片上线：commit → 镜像 → GitOps roll → 线上验收（匿名访问根路径
     到达欢迎卡；六语言文案在产物内；官网页「在线体验」按钮到达欢迎卡）
     证据：commit 4cd247a5（含 merge scs001 bot 线）双远端推送；scs001
     Publish TCR Image run 38645257787 绿 → hkccr sha-4cd247a；
     GitOps d1486d7 roll → ArgoCD revision=d1486d7 同步 → rollout
     successfully rolled out（新 pod sha-4cd247a Running）；
     线上验收：新 bundle index-Be5kJpZf.js 含 user-hero-steps 等新类；
     浏览器实机——匿名 `/` → `/me` 欢迎卡六要素（截图）、已登录 `/` → `/me`
     面板、根路径无解锁墙（`unlock:false`）；官网页「在线体验」指向的
     connector 域根路径现在导流到欢迎卡（同一路径已实证）。
     注：验收时发现**缓存穿透坑**——被缓存的旧 index.html 会继续引用旧
     bundle 而显示解锁墙；带 cache-buster 请求即达新壳。bundle 名变化时
     对回头访客有一次自然刷新成本（服务端无 Cache-Control，浏览器启发式
     缓存），不为本 change 引入新缓存策略
- [ ] 7. 归档
