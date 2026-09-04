# dev_plan_v0.1

## 追踪信息

- 当前状态：本地 MVP 实施与 L2 验收完成
- 目标版本：v0.1
- 上游来源：`docs/prd_v0.1.md`
- 下游承接：`docs/progress_v0.1.md`、后续 `/acceptance`
- 当前事实源：PRD、本文件、progress
- 最后更新：2026-09-04

## 1. 开发范围

- 本次包含：纯浏览器双端 UI、Bun 静态与 WebSocket 信令服务、内存房间、加入批准、WebRTC DataChannel、多文件顺序分块、背压、接收暂存与下载、取消、错误与安全头。
- 本次不包含：TURN、中继上传、数据库、账号、文件夹、断点续传、部署和真机跨系统发布。
- 范围保护：信令服务不得新增文件上传/下载接口；无法直连时必须失败，不得静默经服务器传文件。

## 2. PRD 对照

| PRD 需求点 | 开发模块 | 覆盖方式 |
| --- | --- | --- |
| 房间码与加入批准 | `src/signaling-core.ts`、`src/server.ts` | 纯状态机单测 + WebSocket 集成 |
| 文件不经服务器 | `src/web/peer-session.js`、`src/web/transfer.js` | DataChannel 协议 + 服务端路由审查 |
| 多文件与背压 | `src/web/transfer.js` | 协议单测 + 双页面 E2E |
| 接收确认与保存 | `src/web/app.js`、`src/web/storage.js` | Chromium 双页面 E2E |
| 状态与视觉 | `src/web/index.html`、`src/web/app.css` | 原型测试和截图 |
| 安全边界 | `src/server.ts`、`src/signaling-core.ts` | 白名单、限速、大小、Origin 和响应头测试 |

## 3. 文件与模块影响

| 模块 / 文件 | 改动类型 | 说明 |
| --- | --- | --- |
| `src/signaling-core.ts` | 新增 | 无 IO 的房间、角色、过期、限速和路由状态机 |
| `src/server.ts` | 新增 | Bun HTTP/WS 适配、静态资源、安全头、健康检查 |
| `src/web/app.js` | 扩展 | 页面状态机与真实信令编排 |
| `src/web/peer-session.js` | 新增 | PeerConnection、ICE 与 DataChannel 生命周期 |
| `src/web/transfer.js` | 新增 | 清单、分块、背压、接收状态与取消 |
| `src/web/storage.js` | 新增 | OPFS/内存暂存及用户触发下载 |
| `tests/` | 扩展 | 核心、HTTP/WS、协议和双浏览器验收 |
| `package.json`、`README.md` | 新增 | 开发、测试、构建和部署边界 |

## 4. 实施顺序

1. M0：关闭 PRD 与高保真原型门禁。
2. M1：以失败测试定义并实现信令核心状态机。
3. M2：以失败测试定义并实现 Bun HTTP/WS 边界。
4. M3：以失败测试定义并实现 DataChannel 协议、存储和真实 UI 编排。
5. M4：运行双页面 E2E、安全回归、构建与文档检查。

## 5. 任务拆解

### M1：信令核心

- 目标：一次房间只容纳一发一收，加入需批准，信令严格按角色白名单转发。
- 验证：`bun test tests/signaling-core.test.ts`。
- 完成标准：房间码、碰撞、批准/拒绝、过期、断连、限速和信令注入测试全部通过。

### M2：服务边界

- 目标：同源提供页面与 WebSocket；本轮只验收可信局域网 HTTP，本轮不宣称已适配生产 HTTPS 反代。
- 验证：`bun test tests/server.test.ts`。
- 完成标准：页面/健康检查、安全头、Origin、非法升级和真实双 WebSocket 信令通过。

### M3：浏览器直传

- 目标：两页面完成双向确认与至少一个真实文件的 DataChannel 传输和下载。
- 验证：`python tests/e2e_transfer_test.py`。
- 完成标准：下载字节与源文件完全一致，服务端无文件内容接口，取消能停止。

### M4：候选验证

- 目标：形成可本地运行和部署的 v0.1 源码候选。
- 验证：`bun test`、Playwright 双视口、`bun build` 和 `bun build --compile`。
- 完成标准：命令退出码为 0；限制与未验证真机矩阵写入 README/progress。

## 6. 测试与验收

- 自动化：Bun 单元/集成测试、Python Playwright 真实浏览器端到端。
- 手动检查：桌面/窄屏截图、键盘焦点、文案边界。
- 配置检查：房间 TTL、加入限速、消息大小、允许 Origin。
- 打包检查：本机可执行文件仅验证构建与启动；不创建 Release。
- 回归：原型两条路径、拒绝/取消/过期/错误码、服务端无文件路径。

## 7. 开发日志约定

- 使用 `docs/dev_log_v0.1.md` 记录红—绿测试证据、关键取舍和未覆盖项。
- progress 只保留状态、阻塞、最新验证和下一步。

## 8. 风险与回退

| 风险 | 影响 | 回退 / 处理 |
| --- | --- | --- |
| 无 TURN 在隔离网络失败 | 无法连接 | 明确诊断并结束，不回退服务器中转 |
| 浏览器保存能力不同 | 大文件可能无法暂存 | OPFS 优先、内存限额兜底，真机后决定是否前移直接保存 |
| 6 位码被枚举 | 非预期加入请求 | 短 TTL、按 IP 限速、发送方批准；公开 Beta 前复评码强度 |
| 恶意信令服务 | 可替换对等身份 | v0.1 明示信任边界；后续候选为短认证串比较 |

## 9. 开放问题

- 三平台真实浏览器与局域网矩阵待 L3 验证。
- 正式部署域名、HTTPS、监控与发布渠道不在本轮授权内。
