入口判断：/prd-progress

# progress_v0.2

## 追踪信息

- 当前状态：仓库已公开；“关闭无残留”补修与功能优先首页已本地验证并重建 Windows 产物，用户已授权提交并推送 test；远端 CI 与 L3 真机按对应候选补证
- 目标版本：v0.2
- 上游来源：`docs/prd_v0.2.md`、`docs/dev_plan_v0.2.md`
- 下游承接：test 提交/推送（已授权）→ 新 CI 结果与真机补证 → acceptance → 授权后 release
- 当前事实源：本文
- 最后更新：2026-09-14

## test 推送与其他电脑启动（2026-09-14）

- 用户明确授权推送关闭补修和首页调整；由 `test` 上包含本文的提交承载，不合并 main、不创建 PR、tag 或 Release。推送前 fetch 核对 HEAD 与 origin/test 同为 `db5e419`，无远端分歧；实际提交身份以 Git 为准。
- README 补全首次 clone `test` → `bun install --frozen-lockfile` → `bun start`，以及已有克隆的安全更新步骤。只需一台电脑运行服务，其他电脑通过浏览器打开同一个 LAN 地址；不是每台电脑启动互不相通的独立服务。
- 本地全套 `bun test` 在待交付代码上重新执行，239 pass / 0 fail / 887 assertions。另在不含 node_modules 的临时源码副本中执行 `bun install --frozen-lockfile` 和 `bun run start`：Bun 1.3.14 下安装成功，health/runtime/首页/JS/CSS 均返回 200，受保护关闭后进程自然退出 0、端口可重新绑定。这不是其他物理系统或跨设备验收；新 CI 结果及跨设备/TUN 证据仍需与实际提交对应。

## 功能优先首页与公开仓库（2026-09-13）

- 授权及远端：按用户要求将 `NzyZzz1998/LocalFileTransfer` 从 private 改为 public，并经匿名 GitHub API 验证。未改变默认分支 main，未合并、提交、推送或发布；本地仍在 `test@db5e419` 上保留关闭补修。
- 前端：直接移除标语区及宣传徽章，不换成另一句广告。首页先展示发送/接收，再展示 LAN 地址、复制和本机关闭入口；保留必要的同网、存储、双方确认和未保存风险说明。发送/接收流程统一实用术语，移除航标、货单、靠岸、摆渡等包装和失效样式；演示保存明确标注不下载。
- UI 反证：旧页面在 1280×720 下，发送入口顶端位于 y≈788，未进入首屏。新增真实浏览器检查在 1280×720、390×844 下确认发送、接收、复制地址完整处于首屏，且无横向溢出；修改后通过。
- 验证：`bun test` 239 pass / 0 fail / 887 assertions；浏览器 UI 组（桌面/窄屏、演示流程、真实中转）、direct 组（中转开/关下的真实直连与下载字节）、diagnostics 组（15 场景）通过。Windows 新产物 smoke 核对 10 项资源字节一致、未授权关闭 403、授权关闭 200、自然退出 0；原生产物 `completed-saved` 场景核对下载字节、RTC/WS/计时器/临时文件清理、进程退出及端口释放通过。本轮未重跑完整 shutdown 10 场景，09-07 的完整回归保留为历史证据。
- 最新 Windows 候选：`dist/dukou-windows-x64.exe`，版本 `0.2.0`，SHA256 `7837289854F94B5836EE72513FB5BCEDAE0EC599E3DC0B67E8BC4B23E7EE2969`，与 `dist/SHA256SUMS.txt` 一致。下方旧哈希不再代表当前产物。
- 预览证据：`artifacts/ui-functional-20260913/`；本机 Chrome 实测，不等于手机支持或 macOS/Linux 真机验收。旧远端 CI 结果也不代表当前本地变更。

## 关闭补修（2026-09-07）

- 对象：`test@db5e419` 上的本地未提交工作树，版本仍为 `0.2.0`；本轮未推送、未创建 tag/Release。
- 范围：全部连接清理确认后退出服务；开发 watcher 退出；未保存完整/部分批次保护；清理失败可重试；等待异步文件操作、下载交接及临时文件清理，不误报完成。
- 单元及集成测试：`bun test` → **239 pass / 0 fail / 887 assertions**，13 个文件，包含实际 watch 退出、HTTP/WS 安全边界、引擎取消竞态、清理失败/重试。
- 浏览器：`python tests/run_browser_tests.py --suite all` → 六组全部通过、退出 0（直连开/关、UI、lifecycle、recovery、diagnostics、shutdown）。关闭组 10 个场景覆盖正常/未保存/部分批次/故障/取消/重叠；之后补测“未保存阻止关闭时保留控制心跳”也通过。最终重建 Windows EXE 经 `python tests/e2e_shutdown_test.py --case all --binary dist/dukou-windows-x64.exe` 复验，10 个场景全部通过、退出 0；各场景核对服务自然退出 0、监听端口释放，未依赖强杀。
- Windows 候选：`dist/dukou-windows-x64.exe`；SHA256 `FA212B5FD329EB1EFB1A9A1F65AEAD855378FA41AF2FE8393ADC6DD0B5AB9BCE`，已写入 `dist/SHA256SUMS.txt`。原生 smoke 已核对 10 个嵌入资源字节一致、未授权关闭 403、授权关闭 200、进程退出 0、无需强杀；下方 2026-09-05 哈希仅为历史证据。
- 限制：本地使用 Windows/Chrome；`--browser chromium` 因本机没有配套 headless shell 未能运行。macOS/Linux 本轮运行与跨设备/TUN/吞吐不计为通过。异常崩溃、强杀、断电的历史 OPFS 文件不承诺自动清空，也不扫描或删除其他页面文件。

## 版本目标

直连优先；失败可解释并经双方确认本地中转；真实进度；长传稳定；Windows/macOS/Linux 可构建且按真机证据声明。

## 总体进度概览

| 里程碑 | 模块 | 状态 | 完成度 |
| --- | --- | --- | --- |
| M0 | 范围、PRD、原型门禁 | 已完成 | 4/4 |
| M1 | LAN 地址与生命周期 | 已完成 | 4/4 |
| M2 | 连接诊断与存储预检 | 已完成 | 4/4 |
| M3 | 中转加密 spike | 已完成 | 4/4 |
| M4 | 显式本地中转 | 待补真机 | 4/5 |
| M5 | ACK 进度与性能 | 待补真机 | 2/4 |
| M6 | 跨系统产物与真机 | 待补真机 | 3/5 |

## 模块任务

### M0 范围与原型

- [x] M0.1 复盘 v0.1 与收敛 F1～F7
- [x] M0.2 完整 PRD 和开发计划
- [x] M0.3 桌面发送方中转确认原型
- [x] M0.4 窄屏接收方流程与 91 项回归

### M1 LAN 地址与生命周期

- [x] M1.1 地址枚举纯函数与单测
- [x] M1.2 `/api/runtime`、终端地址和页面接线
- [x] M1.3 配对前 TTL / 配对后活动生命周期分离
- [x] M1.4 本机安全关闭、服务器、浏览器和回归验证

### M2 连接诊断与存储预检

- [x] M2.1 8 秒提示与 20 秒截止
- [x] M2.2 时间线、错误码、脱敏诊断与保留货单重试
- [x] M2.3 单文件/批次 256 MiB 预检
- [x] M2.4 故障注入与 UI 回归

### M3 中转加密 spike

- [x] M3.1 离线可用密码实现选型与锁版
- [x] M3.2 密钥协商、随机数与互操作测试
- [x] M3.3 篡改/重放拒绝与密钥清理
- [x] M3.4 威胁模型与启用结论

### M4 显式本地中转

- [x] M4.1 双方中转协商状态机
- [x] M4.2 一次性角色凭据与独立 `/relay`
- [x] M4.3 密文帧、背压和资源上限
- [x] M4.4 取消/掉线/超限清理
- [ ] M4.5 强制直连失败 E2E 与 TUN 真机

### M5 ACK 进度与性能

- [x] M5.1 接收 ACK 和发送端单调校验
- [x] M5.2 当前/平均速度、用时与 ETA
- [ ] M5.3 真机吞吐基线
- [ ] M5.4 基线驱动调优与回归

### M6 跨系统

- [x] M6.1 四目标构建命令与 Windows x64 产物
- [x] M6.2 Windows 原生产物启动、`/healthz`、runtime、完整资源字节和安全关闭 smoke
- [x] M6.3 未签名产物说明
- [ ] M6.4 三组双向真机矩阵
- [ ] M6.5 acceptance 与 Release 候选

## 当前阻塞

- 本次明确代码缺陷已收口；NXT-007 已完成本地完整回归与 CI 接线。用户已授权推送 test，远端通过状态需核对对应新提交的 Actions；上方里程碑勾选不等同于发布验收通过。
- M4.5 需要两台物理设备在 TUN 开启时验证本地中转。
- M5.3～M5.4 需要真机吞吐基线后才能决定是否调优，当前不得声称“更快”。
- 四平台原生 CI 编译此前已通过，但编译不等于运行；M6 的 macOS/Linux 原生产物 smoke 与三组双向矩阵仍待补证。

## Review 收口状态

| 需求 | 当前状态 | 本批证据 |
| --- | --- | --- |
| NXT-001 会话隔离 | 已修复并通过定向回归 | 旧 connect 晚到后零帧、旧连接关闭；文件快照不随新选择变化；旧信令/RTC 回调失效 |
| NXT-002 直连失败出口 | 第二批已修复并通过回归 | 路线/协商验证失败后保留房间；双方批准中转下载一致；拒绝中转后可再次申请；传输中断不换路 |
| NXT-003 中转资源 | 已修复并通过自动化 | 唯一授权、房间撤销、容量恢复、半连接/空闲超时、原生缓冲限额及 drain 注入 |
| NXT-004 真实存储预检 | 第二批已修复并通过回归 | create/write/close/remove 探针、超限禁止接受、合法内存回退、模式锁定、取消及 abort 拒绝仍清理 |
| NXT-005 错误清理 | 已修复并通过定向回归 | 篡改/重放后 engine failed、sink abort、单次 close、握手 Promise 结束、密钥/队列/轮询释放 |
| NXT-010A 中转开关 | 已实现并通过自动化 | 环境配置、runtime、信令/HTTP 拒绝、页面禁用；启用后真实 UI 中转成功 |
| NXT-006 地址/诊断/UX | 已修复，本地通过 | 推荐和备选可复制、空列表/读取失败区分、双方真实时间线、脱敏快照和手动复制；重试货单/限流/断连/完成状态回归 |
| NXT-007 完整 UI 门禁 | 本地通过；CI 接线完成，远端结果待补 | 一条命令覆盖 direct/UI/lifecycle/recovery/diagnostics；build 依赖 unit/browser，失败不上传发布产物 |
| NXT-008 原生产物与真机 | 自动化已实现；Windows smoke 通过，其余待补 | 四平台 CI 均已增加原生 smoke；本轮 Windows 新产物独立启动并比对全部资源；Mac/Linux 与 L3 未运行 |
| NXT-009 吞吐与调优 | 待补证，未调参 | 无跨设备性能基线；不声称更快；N4 数值仍待 PERF 开始前确认 |
| NXT-010B 发布事实 | 本地材料完成，发布未执行 | README、状态、checksum 与 `docs/release_checklist_v0.2.md` 已同步；不提前批准发布 |

## 首批历史验证（2026-09-05）

- 验证时间：2026-09-05；`test@79d4684` 基础上的本批未提交工作树，不是远端已发布内容
- 验证方式：`bun test`、`tests/e2e_relay_lifecycle_test.py`、既有 WebRTC 和静态/动态 UI 脚本、bundle/Windows x64 构建
- 结果：149 tests / 520 assertions 全绿；真实双方 UI 加密中转完成 196,613 字节逐字节一致下载，成功后双方中转 socket 关闭；旧会话晚到与文件快照、关闭中转场景通过；WebRTC 直连 65,537 字节及既有静态/动态 UI 回归通过；bundle 启动及资源一致性测试通过，Windows x64 编译成功
- 反证：浏览器只替换为旧 HEAD 的 app.js（不修改工作树）时，旧会话关闭与文件快照断言均失败；本批实现通过。
- 追加验证：中转开启/关闭两种配置下，真实 WebRTC 65,537 字节直连与 OPFS 清理均通过；pending/active relay 各阶段的旧 RTC 晚回调不改变路线或关闭连接。
- 验证限制：背压使用确定性 native send/drain 注入，不是慢网络 RSS/吞吐实测；本批 Windows 编译产物的额外启动 smoke 命令被执行策略拒绝，未执行，不沿用旧产物结果；真机项和其余 Bugfix 不算通过。
- 遗留问题：NXT-002/004/006、完整 NXT-007、TUN 真机、吞吐基线、macOS/Linux 原生 smoke 与三组跨系统矩阵
- 证据状态：新测
- 失效条件：页面结构、关键状态机或测试环境变化

## 第二批历史验证（2026-09-05）

- 对象：`E:\codex\LocalFileTransfer`，`test@79d4684` 上两批未提交工作树；版本仍为 v0.2.0，不是远端已发布内容。
- 自动化：`bun test` → **199 pass / 0 fail / 680 assertions**；本批受影响的 PeerSession/storage/app 接线已重测，首批服务端与加密回归未退步。
- 新浏览器：`python tests/e2e_recovery_preflight_test.py --start-server --case all` → **13 场景全部通过**。覆盖空/抛错 stats、不可信候选、协商失败后真实中转；OPFS create/write 失败的大文件拦截和小文件下载；延迟预检/实际 sink 取消；传输中断禁止换路；stats 延迟；拒绝中转后留房再申请。
- 旧浏览器：首批 `e2e_relay_lifecycle_test.py` 四个启用场景、既有静态/动态 UI 均通过；中转开/关两种配置下，原 WebRTC 65,537 字节下载一致与 OPFS 清理均通过。
- 构建：bundle 和 Windows x64 编译成功，`git diff --check` 通过；本批未补编译产物启动 smoke，不沿用旧产物运行证据。
- 产物：`dist/dukou-windows-x64.exe`，SHA256 `F191AA0995B996D99B7598208A31150C4BD3461A9AFD28958BF5ACF8BE65DD03`；对应上述 dirty 工作树。
- 证据边界：真实浏览器 API 故障注入，不是跨物理设备验收。1 字节探针仅证明当时可写，不预留整批磁盘空间，不改变 256 MiB 内存合同。大文件测试仅替换元数据，未分配或发送大文件内容。
- 清理：本批独立测试端口 4133～4137 均无残留监听，历史截图未覆盖；未提交、推送、tag 或发布。
- 证据状态：新测；相关源码、配置、产物或浏览器环境变化后重测受影响项。

## 本地验证：全部修复收口（提交前，2026-09-05）

- 对象：`E:\codex\LocalFileTransfer`，`test@79d4684985836f42494164b20b093db594397d10` 上三批未提交工作树；版本 `0.2.0`，不是远端已发布对象。
- 自动化：`bun test` → **217 pass / 0 fail / 757 assertions**，13 个测试文件；包含 3 个真实原生产物 smoke 回归，错误版本与陈旧资源必须失败并清理进程。
- 浏览器：统一入口 `bun run test:browser` → **全部通过，exit 0**；新 `e2e_diagnostics_test.py` 15 个场景、上批 recovery 13 场景，以及既有直连双配置、UI、lifecycle 均通过。真实页面和故障注入混合，不代替物理设备或性能证据。
- 独立复核：连续 6 次错码的诊断陈旧、离房后的无效中转按钮均先复现再修复，并由只读 reviewer 在真实页面复核关闭；另有货单重试、活动断连状态和完成后关页的 RED→GREEN 证据。
- 构建：`bun run build`、Windows x64 编译通过；主代理再执行 `bun run smoke:binary dist/dukou-windows-x64.exe` → `ok:true`、10 个嵌入资源逐字节一致、无头关闭 403、合法本机关闭 200、正常退出 0、无需强制清理。
- 产物：`dist/dukou-windows-x64.exe`；SHA256 `A8A0157F0DD2CAED1327C819E6A99C8EDE13F64B8C13474330C5BF52ADD46794`，校验文件 `dist/SHA256SUMS.txt`。第二批旧哈希仅保留历史，不再指向当前候选。
- 依赖与差异：`bun audit` 无已知漏洞；`git diff --check` 通过。系统提示 YAML 将按仓库策略转为 CRLF，不是测试或空白错误。
- CI 边界：已写入 unit/browser 前置与四原生 smoke 步骤；本轮未推送，因此不声称新 CI 或其他 OS 已运行。本地实际浏览器为 Chrome，CI 配套 Chromium 尚待执行。
- 证据状态：新测；源码/配置/依赖/浏览器环境变化后重测对应项，重建后重新锁定产物哈希。
- 清理与授权：统一最终浏览器端口 7616 和原生产物 smoke 端口 9070 均由自有进程管理；未操作用户 3000 服务、系统 TUN 或防火墙，未提交/推送/tag/Release。历史截图未覆盖。

## 下一步

- 上轮修复基线为 `test@db5e419`；本轮关闭补修、功能优先首页及启动说明已获提交/推送 test 授权。接下来核对本次新提交的 CI；不合并 main、不创建 tag/Release。
- 远端 CI 按承载相应代码的提交核对 [Actions](https://github.com/NzyZzz1998/LocalFileTransfer/actions/workflows/build.yml)，不能沿用旧提交的结果，也不把授权或触发当作通过。
- 用户方便时再补 Windows↔macOS、TUN 和吞吐。发布面与最小待执行动作见 `docs/release_checklist_v0.2.md`。

## 记录边界

本文只记录状态、阻塞、验证结果和下一步；技术过程写入 `docs/dev_log_v0.2.md`。
