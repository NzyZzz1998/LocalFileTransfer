入口判断：/prd-development-log

# v0.2 开发日志

## 基本信息

- 版本：v0.2
- 对应 PRD：`docs/prd_v0.2.md`
- 对应 dev plan：`docs/dev_plan_v0.2.md`
- 对应 progress：`docs/progress_v0.2.md`
- 当前阶段：本次 Review 代码与本地自动化收口；新远端 CI 与 L3 真机证据待补

## 开发记录

### 2026-09-04 / M0 需求与原型门禁

- 本轮目标：把用户确认的“完整版本 + 跨系统”收敛为可开发合同。
- 改动模块：PRD、开发计划、v0.2 高保真交互原型、Playwright 测试。
- 关键实现：直连超时停住、发送方申请中转、接收方看到零字节后批准、容量合同、路径常驻状态、真实指标占位。
- 遇到的问题：窄屏测试的 `0 B` 选择器命中隐藏发送区；旧 UI 合同要求独立接收路径出口。
- 处理方式：将选择器限定到接收中转卡；恢复 `receiver-connection-status`。
- 已验证：桌面 1440×960、窄屏 390×844；控制台/page error 为零；91 tests / 302 assertions。
- 未验证：真实 runtime、真实中转、跨系统真机和吞吐。

### 2026-09-04 / M1 地址、生命周期与本机关闭

- 本轮目标：让用户无需命令查 IP，并修复长传被建房 TTL 误杀；补充用户要求的关闭入口。
- 改动模块：runtime-info、server、peer-session、首页、server/signaling/browser tests。
- 关键实现：实体 WLAN/网线优先，虚拟网卡与 JiuX TUN 降权但保留候选；15 秒应用心跳；配对后移除建房 TTL；本机限定关闭 API。
- 遇到的问题：`vEthernet` 名称包含 Ethernet，首次排序错误推荐 Hyper-V `172.21.32.1`；旧的临时 43123 测试进程占用端口。
- 处理方式：虚拟/TUN 规则先于实体网卡规则并补测试；仅结束本轮创建的 43123 临时进程，未触碰用户 3000 端口服务。
- 已验证：动态首页推荐本机 WLAN `192.168.31.73`；关闭接口拒绝缺少同源动作凭据的请求；配对后推进 10 分钟仍可转发信令。
- 未验证：其他操作系统的网卡命名与关闭行为，留待 M6 平台 smoke。
- 范围修订：用户指出移动端不在支持范围，二维码缺少有效使用场景；已从页面、接口、依赖和验收中移除。

## 关键决策

| 决策 | 背景 | 取舍 | 后续观察 |
| --- | --- | --- | --- |
| F1～F7 进入 v0.2 | 用户不希望只有单功能，并要求跨系统 | 版本更完整，分里程碑控制风险 | progress 逐项验收 |
| 直连 8 秒提示/20 秒截止 | 当前失败表现为长期等待 | 先给确定出口，再依据数据调整 | 真机建连分布 |
| 内存批次总量 256 MiB | LAN HTTP 无 OPFS | 保守、可预期；大文件另立架构 | 真实文件大小 |
| 中转先过密码 spike | LAN HTTP 无 Web Crypto secure context 保证 | 加密不可用就禁用，不明文降级 | M3 结果 |

### 2026-09-04 / M2～M5 可靠传输主链路

- 本轮目标：让直连失败在有限时间内进入可操作出口，并完成双方批准、零字节门禁的加密本地中转。
- 关键实现：8 秒慢连接提示与 20 秒截止；脱敏诊断；OPFS/256 MiB 内存预检；一次性中转角色凭据；独立 `/relay`；TweetNaCl 临时密钥协商、认证加密、篡改/重放拒绝；ACK 驱动进度与 2 秒速度窗口。
- 资源边界：中转只接受受限二进制帧，不写磁盘；断连清空整段会话；无加密实现时明确失败，不降级明文。
- 浏览器证据（2026-09-05 Review 更正）：浏览器内直接创建底层对象，完成中转协商与加密文件一致性验证；当时未覆盖双方真实 UI 按钮接线。静态桌面/窄屏原型路径无控制台错误。
- 尚缺证据：物理设备在 TUN 开启时的中转结果、真机吞吐基线。

### 2026-09-04 / M6 构建收尾

- 已完成：Windows x64 单文件产物；Windows、macOS arm64、macOS x64、Linux x64 四目标命令；README 的未签名产物说明。
- 遇到的问题：Bun 1.3.14 在 Windows 交叉编译三个非 Windows 目标时报告目标运行时下载/解包失败；同类问题已在 Bun 官方仓库公开且未关闭。
- 状态处理：不把工具链失败写成源码失败，也不把未运行的平台写成已支持；macOS/Linux 原生构建与启动 smoke 保留为 L3 待补证。

## 2026-09-04 历史验证摘要

- 自动化：113 tests / 362 assertions 全绿；bundle 构建通过。
- 浏览器：静态/动态 UI 回归、65,537 字节 WebRTC 直连 E2E、浏览器内底层加密中转集成均通过；真实双方 UI 中转证据由下方新批次补齐。
- 打包：Windows x64 已生成并通过 health/runtime/页面/中转资源/本机关闭 smoke；三个非 Windows 交叉目标受 Bun 工具链缺陷阻塞，已补四平台原生 GitHub Actions 构建矩阵。
- 未覆盖：跨系统物理设备、TUN 真机与吞吐基线。

## 收尾事项

- 文档同步：M0 已完成。
- 发布说明：未开始；未经授权不推送、tag 或创建 Release。
- 回滚方式：页面原型与实现批次分离；中转保留 feature flag。

### 2026-09-05 / Review 首批：会话、资源、错误与中转开关

- 授权与范围：用户 `go` 授权 NXT-001 / NXT-003 / NXT-005 / NXT-010A。沿用 MyPM 的需求池→开发计划→progress/dev log 追踪；本批不扩大为 v0.3，不推送或发布。
- 会话修复：退出先同步失效 scope，再取消/关闭其 engines、pending/active relay、信令和 RTC；每房间冻结角色和文件选择，所有关键 await 后校验所有权，临时 sink 晚到会清理。PeerSession 去重 connect、退出 reject，并隔离旧 socket/offer/answer/ICE/stats 回调。
- 独立复核发现并修复：中转选定后，旧 RTC 的 slow/timeout/negotiation error 仍可覆盖中转状态；已与其他旧 RTC 事件一起过滤。
- 追加浏览器证据：在 relay connecting / awaiting acceptance 两阶段各注入上述三个事件，路线和通道保持不变；仅通过 route 临时移除 guard 时立即断言失败，本批实现通过。
- 服务端修复：凭据绑定房间与参与者，唯一 issued/active 中转；离房撤销；容量、半连接与空闲期限回收；所有索引和双方 socket 一起释放。
- 背压：每次发送重新读取 native 缓冲并预留 WebSocket 帧头；`send=-1` 已接受、不重发，`send=0` 明确 `RELAY_LIMIT` 关闭，`drain` 释放额度。不建立第二个无界 JS 帧队列。依据：[Bun WebSocket](https://bun.sh/docs/runtime/http/websockets)、[getBufferedAmount](https://bun.sh/reference/bun/ServerWebSocket/getBufferedAmount)、[drain](https://bun.sh/reference/bun/WebSocketHandler/drain)。
- 错误修复：transport 唯一终止器，20 秒握手截止、AbortSignal、带固定 code 的 close/error、cipher 清理、64 帧/1 MiB 监听前暂存、单个可取消 drain 轮询。篡改和重放会传播为引擎失败并 abort sink。
- 配置：`RELAY_ENABLED=0/false` 关闭服务端及页面中转；默认继续启用。资源数值是有限资源合同的可配置工程初始值，不宣称经过吞吐调优，详见 PRD/README。
- 新测试：`tests/e2e_relay_lifecycle_test.py` 使用两个独立浏览器上下文、真实页面批准和加密 transport，强制直连超时；196,613 字节下载逐字节一致，确认前不建立 relay socket，每端仅一个，成功即关闭。故障注入验证旧 connect 不会发送下一轮文件、房间文件快照不变；关闭配置时保留直连重试。
- 红绿证据：旧实现的篡改/重放留在进行态、握手取消挂起、旧 PeerSession 回调污染均先复现；浏览器 route 仅替换旧 HEAD app.js 时，pending close 与冻结 manifest 断言失败，本批实现通过。未修改工作树回退业务源码。
- 完整回归：`bun test` → 149 pass / 0 fail / 520 assertions；既有 WebRTC 65,537 字节下载、静态桌面/窄屏及动态首页/底层中转回归通过；`bun run build`、`bun run compile:windows-x64`、`git diff --check` 通过。
- 开关回退实证：额外以 `RELAY_ENABLED=0` 启动独立服务，运行既有完整 WebRTC E2E；65,537 字节直连下载一致且 OPFS 退出清理通过。最终 enabled/disabled 中转页面回归再次通过，测试均无服务残留。
- 产物限制：额外 Windows 编译产物启动 smoke 的 PowerShell 命令被执行策略拒绝，未实际启动；本批仅声明编译通过及 bundle 的自动启动/资源测试通过。
- 测试隔离：浏览器脚本自行管理独立 Bun 进程；通用 with_server helper 在 Windows 留下子进程后已仅清理该测试 PID，并改用不经 shell 的直接子进程管理。测试截图使用临时目录，未覆盖历史截图，未操作用户 3000 端口服务。
- 尚未完成：NXT-002/004/006、完整 NXT-007、跨系统/TUN 真机与性能基线；不据此宣称 v0.2 验收或性能提升。

### 2026-09-05 / 第二批：NXT-002 直连恢复与 NXT-004 真实可写预检

- 授权：用户在首批交付后要求“继续”；按 MyPM 沿用 PRD/dev plan/progress，按需求池 NXT-002/004 实施，不重写 PRD，不开展远端发布。
- 根因与红灯：直连 RTC close 被页面当作整房间退出；stats 失败还会残留旧 ReceiverEngine，挡住中转接线。浏览器缺失 stats 用例先出现中转批准后无法收到清单。存储只调用 getDirectory，300 MiB 清单返回 allowed:true 而 writeAttempts=0；原生 createWritable 拒绝时，大文件接受按钮仍错误开放。
- PeerSession：独立 RTC attempt 状态；统一 direct_failed 在关闭 RTC 前通知，房间/信令/心跳不变；closeDirect 静默清理旧 RTC。20 秒期限覆盖 stats 验证而非原始 channel open；旧 offer/answer/ICE/stats、已排队计时器不复活旧通道。disconnected 仍作为暂时中断，不立即终止已建连接。
- 页面恢复：只允许未开始传输的 idle/awaiting_acceptance engines 退出旧路线；先解绑监听和清空引用，再本地终止，不发误导性的用户取消。接收方仍提前监听清单，但接受按钮必须同时满足路线已验证与存储预检通过，避免早到 manifest 丢失或提前接收。
- 不中途换路：receiving/transferring 为不可换路边界；实际块落盘后强制断 RTC，整轮失败并清理，不展示可继续本轮的中转出口。
- 存储：校验完整清单后，创建唯一 `.dukou-probe-*` 临时文件并写 1 字节、关闭、删除；每一步失败都处理清理，持久删除失败明确报告 STORAGE_CLEANUP_FAILED，不冒充成功。无法使用 OPFS 时，只允许单文件及整批均不超过 256 MiB 的内存回退；超限显示文件或批次原因。
- 合同锁定：页面将预检选择的 mode 传给 createStorage；锁定 OPFS 后实际 sink 创建失败不再悄悄转内存，锁定 memory 则不重试 OPFS。界面明确“浏览器未提供精确容量”，探针不是整批空间预留。
- 独立 review 追加：拒绝中转曾隐式 leave，现保留房间并允许再次申请，显式关闭仍负责退出。实际 sink 晚到且 abort 拒绝会跳过文件移除，已用 finally 保证移除尝试及 cleanup 兜底；删除仍失败时保留可重试状态。
- 红绿回归：新增 PeerSession 与 storage 单测先红后绿；浏览器 missing-stats、storage-large、relay-decline 原路径分别失败，修复后通过。临时 sink abort 拒绝有单测红绿及真实浏览器集成验证。
- 最终验证：`bun test` 199 tests / 680 assertions 全绿；新 `tests/e2e_recovery_preflight_test.py` 13 个真实浏览器场景全绿；首批四个中转/会话启用场景、原 WebRTC 开关两配置及静态/动态 UI 回归通过；bundle、Windows x64 构建、差异检查通过。最新产物身份见 progress，不把编译视作运行验收。
- 测试工程处理：连续场景触发了真实来源 IP join 限流；改为每场景独立自管服务，不放宽生产限流。测试仅替换原生 RTC/OPFS 依赖边界，保留真实 UI、信令、传输和下载；临时截图未覆盖历史产物。
- 部分贡献边界：本批失败面板及复制诊断改为实际错误码和耗时，避免把所有新失败伪装为 20 秒超时；NXT-006 的完整地址/诊断仍未结束，NXT-007 的 CI 接线仍待做。
- 未验证：Mac/Linux 原生产物运行、跨物理设备/TUN 与吞吐。未提交、未推送、未创建 tag/Release。

### 2026-09-05 / 全部修复收口：NXT-006、007、008 自动化及 010B 本地材料

- 授权：用户要求“继续到完成本次全部修复”。按 MyPM 沿用既有 PRD/计划，不重写产品合同；原需求池分清代码缺陷、自动化接线和必须外部补证的项目。
- 地址根因：服务返回完整 `lanUrls`，页面却只消费推荐字段且以 location.origin 兜底。现逐个显示去重候选和复制动作，loopback 不冒充 LAN；空列表与 runtime 请求失败采用不同状态。不新增网卡名称、可达性探测或 API 字段。
- 诊断根因：页面只有固定、会隐藏的发送方时间线，复制内容也缺少实际阶段和连接状态。PeerSession 增加可注入单调时钟的 phase 快照，追踪配对/查路/通道验证；在 RTC 清理前冻结失败原因、阶段耗时及连接状态。枚举白名单排除原始错误、候选地址、SDP、房间与文件。
- UI：两端常驻时间线按实际 phase 和传输引擎事件更新；中转阶段覆盖旧直连失败显示，但不更改底层批准合同。信令失败在建房前也有可见错误和诊断入口；无剪贴板权限时以只读、选中文字的 dialog 降级。ACK 标签改“对方已接收”，中转统一指“运行渡口服务的电脑内存”。
- TDD 及复核补漏：重试直接读取新 selectedFiles 曾串换货单，现复用原 scope.files；连续错码的首错冻结掩盖第六次 RATE_LIMITED，现成功提交新 join 后重开 joining_room 阶段；离房后禁用无效中转按钮，新房间失败时恢复。后两项由独立 reviewer 真 UI 先复现再复核关闭。
- 终态补漏：活动直连中断时 app 的 transferring 覆盖层曾遮住 Peer 失败，现记录真实首到错误及 failedStage；成功后对端离房曾把 completed 改为 failed，现保护已完成/已取消结果。两个浏览器测试均先观察错误 JSON，再验证修复，不把 PEER_LEFT 与 DIRECT_CHANNEL_CLOSED 的真实先后竞态伪装成唯一原因。
- 自动化工程：新增统一 Python runner，自动选空闲端口、只清理自有进程、临时截图、不放宽生产限流。旧 UI 依赖过时标题、旧竞态测试要求隐藏时间线，与本轮明确 UI 合同冲突；改为稳定面板选择器和时间线状态保持断言，不删除原有竞态/下载检查。
- CI：unit 与完整 browser 为四平台构建上传的前置；每个原生 runner 编译后执行 smoke。smoke 从非源码临时目录运行真正二进制，检查 healthz/runtime/version/10 项资源字节和受保护的本机关闭，输出 SHA256；错误版本及陈旧资源真实失败并清理。新 CI 尚未推送运行。
- 最终验证：217 tests / 757 assertions 全绿；统一浏览器 direct、UI、lifecycle、recovery 13 场景、diagnostics 15 场景全绿；bundle 与 Windows x64 编译通过。主代理独立复跑 Windows 原生 smoke，10 项字节一致、403/200 关闭边界和退出 0 通过；具体候选哈希唯一记录于 progress/校验文件。
- 文档：同步需求池、progress、README、计划状态；历史收敛文档仅纠正当前分支为 test，不重写 PRD。新增 `docs/release_checklist_v0.2.md` 与本地 checksum。
- 未执行：本次提交、推送、tag、Release；新远端 CI、Mac/Linux 本轮原生运行、跨物理设备/TUN 和性能。NXT-009 没有基线，不做参数调优或提速声明；不要求当前不方便的用户立即验收。

### 2026-09-05 / 授权推送 test 与 CI 承接

- 用户同意“先推到 test 跑 CI，真机验收有空再做”；本轮提交与推送已获授权，不合并 main、不创建 tag/Release、不修改仓库可见性。
- 推送前核对本地与远端 test 均为 `79d4684`、Git 工作区无其他分支状态变动；仓库可见性为 private，保持不变。三批修复、测试及文档属于本次提交范围，dist 产物保持忽略。
- MyPM 状态只更新授权和证据边界，不提前把尚未完成的新 CI 写为通过；实际提交与 Actions 链接在当前任务交付。
