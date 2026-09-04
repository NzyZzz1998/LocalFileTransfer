# v0.1 开发日志

## 基本信息

- 版本：v0.1
- 对应 PRD：`docs/prd_v0.1.md`
- 对应 dev plan：`docs/dev_plan_v0.1.md`
- 对应 progress：`docs/progress_v0.1.md`
- 当前阶段：本地 MVP 验收完成（L2）

## 开发记录

### 2026-09-04 / 需求与原型

- 本轮目标：将“接收端服务”改为两端纯浏览器 WebRTC 方案，并关闭高保真原型门禁。
- 改动模块：PRD、`src/web/`、`tests/ui_prototype_test.py`。
- 关键实现：工业票据/渡口调度视觉；发送与接收双入口；模拟房间、批准、清单、进度和保存状态。
- 遇到的问题：Playwright 自带 Chromium 未安装；最初文本定位同时命中隐藏的 aria-live 节点。
- 处理方式：使用本机 Chrome 可执行文件；把测试定位收紧到语义区域。
- 已验证：测试先因原型文件缺失失败，生成原型后退出码 0；已人工查看两个截图。
- 未验证：真实信令、WebRTC、文件字节与跨系统。

### 2026-09-04 / 信令核心

- 本轮目标：关闭纯浏览器方案的房间、批准、信令路由、清理与限速底座。
- 改动模块：`src/signaling-core.ts`、`tests/signaling-core.test.ts`。
- 红—绿证据：依次观察拒绝加入、offer/answer、ICE、路由字段注入、TTL、断连、二进制、UTF-8 超限、非法 JSON、来源限速、主动离开和心跳测试失败，再做最小实现；最终 16 个测试全部通过。
- 关键实现：6 位码碰撞规避；单发送/单接收人工批准；角色化 WebRTC 信令；房间到期/断连解绑；按 `clientKey` 跨 WebSocket 重连限速；只收受限文本 JSON。
- 未验证：真实 Bun WebSocket 适配、浏览器 ICE/DataChannel 和实际文件字节。

### 2026-09-04 / HTTP 与 WebSocket 服务

- 本轮目标：让同一个 Bun 进程提供自包含网页、同源 WebSocket 信令、健康检查与命令行启动。
- 改动模块：`src/server.ts`、`tests/server.test.ts`、`package.json`。
- 红—绿证据：先观察静态资源、安全头、Origin、双 WebSocket、主动过期、CLI 与容量拒绝测试失败，再实现适配；最终服务与信令定向共 34 个测试通过。
- 关键实现：网页模块编译时嵌入；无文件上传接口；同源 Origin；消息大小边界；1 秒主动过期扫描；总连接、单来源连接、房间与限速桶硬上限。
- 范围结论：本轮只验收可信局域网 HTTP；公网 HTTPS/WSS 反代适配不作已完成声明。

### 2026-09-04 / 浏览器点对点传输

- 本轮目标：以真实 WebRTC DataChannel 完成双向确认、分块传输、暂存和下载。
- 改动模块：`src/web/peer-session.js`、`src/web/transfer.js`、`src/web/storage.js`、`src/web/app.js` 及对应测试。
- 红—绿证据：覆盖未批准零字节、16 KiB 边界、多文件顺序、背压、字节不符、存储容量、取消、断线、发送读失败、内部等待释放和异步 abort 竞态；最终 `peer-session + transfer + storage + UI contract` 共 56 个测试通过。
- 关键实现：只配置 host 类直连所需的空 ICE server 列表；只有双方 candidate 类型均为 `host`、`srflx` 或 `prflx` 才认证为非中继路线；unknown、缺失与 relay 均停止。OPFS 优先、256 MiB 内存兜底，保存由用户点击触发。
- 生命周期收口：对方取消、DataChannel/PeerConnection 断开与信令等待断开均显示可见错误；返回活跃房间或未保存完成页会确认；关页清理 OPFS 临时文件。

### 2026-09-04 / 构建与 L2 验收

- 全量测试：`bun test` 为 91 通过、0 失败、302 个断言。
- 原型回归：`python -u tests/ui_prototype_test.py` 退出码 0，覆盖 1440×960 发送端与 390×844 接收端。
- 真实传输：两个隔离 Chromium 上下文经真实 HTTP/WS/WebRTC 完成 65,537 字节文件传输，下载逐字节一致；同时验证未保存确认、关页临时文件清理和页面错误为 0。
- 打包验证：`bun run build` 生成 `dist/server.js`；`bun run compile` 生成 Windows `dist/dukou.exe`；直接从该 exe 启动后的健康检查、全部静态模块和真实 E2E 均通过。
- 未覆盖：Windows↔macOS、Windows↔Linux、macOS↔Linux 真机互传；公网部署与 HTTPS/WSS 反代。

## 关键决策

| 决策 | 背景 | 取舍 | 影响范围 | 后续观察 |
| --- | --- | --- | --- | --- |
| 两端纯浏览器 | 用户希望接收端也只打开浏览器 | 局域网内需有一台电脑启动页面/信令服务；换取两端零客户端安装 | 架构、运行、保存方式 | 首次连接与保存体验；公网化时再补 HTTPS/WSS |
| 禁用 TURN | 只做局域网且文件不经服务器 | 隔离网络会失败 | ICE 配置、错误提示 | L3 真机成功率 |
| 先用 6 位码 | 输入成本低 | 强度有限，必须配合 TTL/限速/批准 | 房间协议、安全 | 公开 Beta 前复评 |

## 验证摘要

- 自动化验证：91 项 Bun 测试、原型 Chromium 与真实双浏览器 E2E 通过。
- 手动验证：已查看桌面发送结果与窄屏接收完成截图。
- 打包验证：bundle 与 Windows 单文件程序构建、启动、静态资源和真实传输通过。
- 未覆盖项：三平台异构真机、实际两台物理设备局域网矩阵、HTTPS 公网部署。
