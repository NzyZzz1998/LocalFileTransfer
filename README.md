# 渡口 DUKOU

渡口是一个面向桌面电脑的局域网文件快传工具。一台电脑运行渡口，发送端和接收端都只需用 Chrome、Chromium 或 Edge 打开同一个局域网页面，再用 6 位接收码配对。

v0.2 优先使用 WebRTC 点对点直连；协商或路线验证失败（最长等待 20 秒）时，发送方可以申请经过运行渡口服务的电脑内存转发。中转必须由接收方再次同意，文件在浏览器内使用临时密钥加密，服务端不落盘，也不会静默切换路线。

> 当前只支持桌面端使用场景，尚未验证手机浏览器，因此不提供二维码入口。

## 本地运行

先安装 Git 和 [Bun](https://bun.sh/)（当前测试版本为 1.3.14）。最新 v0.2 候选在 `test` 分支，默认 `main` 尚未合并这些更新。

首次在一台电脑上运行：

```bash
git clone --branch test https://github.com/NzyZzz1998/LocalFileTransfer.git
cd LocalFileTransfer
bun install --frozen-lockfile
bun start
```

已经克隆过项目时，先确认本地修改已妥善保留，再切换并更新：

```bash
git switch test
git pull --ff-only origin test
bun install --frozen-lockfile
bun start
```

更新前先正常关闭旧服务。只需要一台电脑运行 `bun start`，所有发送端和接收端都打开这台电脑显示的同一个局域网地址；无需每台电脑都克隆、安装依赖或分别启动服务。Windows/macOS/Linux 的源码启动命令相同，实际跨设备验证范围见下文。

也可以编译为当前操作系统的单文件程序。Windows 示例：

```powershell
bun run compile
.\dist\dukou.exe
```

默认监听 `0.0.0.0:3000`。启动后，终端和首页都会显示推荐的局域网地址（例如 `http://192.168.1.20:3000`）；首页同时列出其他网卡候选，各自可复制。推荐不代表已验证可达，打不开时可尝试备选。没有 LAN 地址会明确标为“仅本机可用”，不会把 localhost 当作另一台电脑的入口；读取失败则单独提示重试。

一端选择“发送文件”，另一端选择“接收文件”。发送方把 6 位码告诉接收方并批准连接；接收方核对文件清单后才会开始传输。接收电脑无需安装客户端。

若另一台电脑无法打开页面，请确认两台设备位于可互访的同一局域网、没有使用隔离设备的访客 Wi-Fi，并允许系统防火墙放行 TCP 3000 端口。VPN/TUN 可能干扰 WebRTC 直连；v0.2 会在超时后提供双方确认的本地中转出口。

运行服务的电脑通过 `localhost` 打开首页时，可以使用“关闭渡口服务”；局域网中的其他电脑看不到该入口，也不能远程调用关闭接口。

关闭会通知各个传输页面停止直连/中转、心跳与计时器，并等待正在进行的文件操作和本页临时文件清理，再退出服务、释放端口。开发模式的文件监听进程也会退出。浏览器标签页和启动它的终端窗口不会被强行关闭；看到关闭成功后可自行关闭窗口。

接收端仍有未保存文件时（包括多文件批次中已经收完的部分），会保留这些文件并暂停关闭。请先保存，或在接收端返回首页并明确确认放弃，再回到本机重试关闭。保存按钮只表示已交给浏览器下载，请检查浏览器下载结果。临时文件清理失败或页面未回应时也会明确提示，不会误报已关闭。

清理只针对当前页面登记的渡口临时文件，不删除原文件、已下载文件或其他页面的存储。浏览器崩溃、强制结束进程、断电后遗留的历史存储不在正常关闭保证内；仅关闭标签页也不等于停止渡口服务。

### 只启用直连

中转默认开启。需要暂时关闭时，在启动前设置环境变量（修改后重启服务）：

```powershell
# Windows PowerShell
$env:RELAY_ENABLED = "0"
bun start
```

macOS/Linux：`RELAY_ENABLED=0 bun start`。设为 `1` 可恢复；也接受 `true/false`，其他值会启动报错。单文件程序读取同一环境变量。

关闭后页面隐藏中转入口，信令拒绝申请，`/relay` 返回 503；直连及原有诊断仍可用。`/api/runtime` 的 `relayEnabled` 可用于确认当前配置。

中转使用可配置的工程初始边界（不是已测最优性能参数）：

| 边界 | 初始值 |
| --- | --- |
| 同时授权/活动的中转 | 每房间 1 个，服务 64 个，每参与来源 IP 8 个 |
| 凭据 / 半连接 / 活动空闲期限 | 60 秒 / 首端连接后 30 秒 / 无有效帧 120 秒 |
| 服务端发送缓冲 | 单 socket 4 MiB、单中转 8 MiB、总计 32 MiB |
| 单帧 / 浏览器监听前暂存 | 256 KiB / 64 帧且不超过 1 MiB |

客户端连接与密钥握手最多等待 20 秒。等待用户核对清单也计入 120 秒空闲期限；超时或超限会明确停止，需重新连接。代码集成可通过 `startServer({ relayConfig })` 调整服务端限额；没有对应的数值环境变量。

## 传输与安全边界

- 未配对房间创建 10 分钟后失效；配对后不再受这段建房 TTL 影响。
- 发送方批准连接前不交换 WebRTC offer；接收方批准文件清单前不发送文件字节。
- 直连使用可靠、有序的 WebRTC DataChannel，文件不经过渡口服务进程。
- 本地中转需发送方申请、接收方同意，使用一次性角色凭据与临时 Curve25519/XSalsa20-Poly1305 会话密钥；服务端只转发不透明二进制帧，不保存文件。
- 发送端进度以接收方确认的字节数为准，并显示当前速度、平均速度、用时与 ETA。
- 接收前实际创建、写入并删除临时探针，检查 OPFS 是否可写；不可用时以内存暂存，单文件和整批文件上限均为 256 MiB。探针不预留整批磁盘空间，浏览器未提供精确剩余容量。
- 预检选择的存储模式在接受后锁定；后续 OPFS 故障会明确停止，不静默改用内存。路线验证或存储预检未通过时，不能开始接收文件。
- 直连验证/协商失败时保留配对房间，可重试或经双方同意中转；拒绝中转只拒绝本次改路。已经开始传输后断线则结束本轮，不中途更换路线。
- 中转加密可以防止普通被动监听或日志直接看到文件内容，但局域网 HTTP 无法抵抗网页被主动替换、恶意渡口程序或主动中间人，不应视为与 WebRTC DTLS 等价。
- 服务端仍能看到连接时间、来源地址、房间码及必要的连接元数据；诊断复制不包含房间码、IP、SDP、文件名、路径或文件内容。
- 双方时间线随配对、查路、验证、中转和传输事件推进；诊断记录实际阶段、阶段/总耗时、错误码与关闭前的连接状态，只含系统/浏览器大类。新一次查码更新错误，重试保留原货单，正常完成不因对方关页改为失败。
- 局域网 HTTP 下剪贴板 API 可能不可用；地址和诊断会显示只读、已选中的文字，方便手动复制。

## 开发与构建

```bash
bun run dev
bun test
bun run build
bun run compile
```

四个目标的构建命令为：

```bash
bun run compile:windows-x64
bun run compile:macos-arm64
bun run compile:macos-x64
bun run compile:linux-x64
```

`bun run compile` 生成当前操作系统的单文件程序。Bun 也支持交叉编译目标，但当前版本在 Windows 下载/解包非 Windows 运行时时可能失败；发布产物应优先在相应原生系统上构建并做 smoke 验证。

这些产物尚未签名：Windows 可能显示 SmartScreen 提示；macOS 可能被 Gatekeeper 阻止；Linux 下载后可能需要 `chmod +x ./dukou-linux-x64`。只应运行来自本仓库可信 Release 或自行构建的程序。

## 浏览器验收

真实浏览器 E2E 需要 Python Playwright 和 Chrome：

```bash
python -m pip install playwright==1.58.0
python -m playwright install chromium
```

一条命令运行完整回归（自动选空闲端口、管理独立服务、使用临时截图，不使用 3000）：

```bash
bun run test:browser
```

包括直连的中转开启/关闭配置、桌面/窄屏 UI、会话隔离、中转故障、存储异常、地址/诊断和完整关闭回归。可用 `python tests/run_browser_tests.py --suite shutdown` 单独验证关闭；每个关闭场景自建随机端口的服务，并检查进程正常退出与端口释放。`--browser chromium` 强制使用 Playwright 配套浏览器。

在一个终端启动测试服务：

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "4123"
bun start
```

再在另一个终端执行：

```powershell
python tests/e2e_transfer_test.py --base-url http://127.0.0.1:4123
```

新增真实 UI 中转与会话隔离回归可自行启动、清理独立测试服务：

```powershell
python tests/e2e_relay_lifecycle_test.py --start-server
python tests/e2e_relay_lifecycle_test.py --start-server --case disabled
python tests/e2e_recovery_preflight_test.py --start-server --case all
python tests/e2e_diagnostics_test.py --start-server --case all
```

上述独立脚本默认端口分别为 4127、4133 和 4138，支持 `--base-url` 覆盖；优先使用会自动选端口的统一命令。每个隔离场景使用自己的服务状态，端口已占用时拒绝启动，不影响现有服务。中转成功场景使用真实双方页面和加密传输；异常场景使用故障注入，不能替代物理设备验收。

脚本会查找常见位置中的 Chrome/Chromium，找不到时使用 Playwright 自带的 Chromium。浏览器在其他位置时可设置 `CHROME_PATH`。

## 当前验证范围

自动化已覆盖信令状态机、Origin 与安全头、真实 WebSocket、WebRTC 会话、8/20 秒超时、加密中转、篡改与重放拒绝、ACK 进度、OPFS/内存预检、浏览器下载字节一致性，以及桌面/窄屏 UI。Windows x64 单文件构建与原生产物启动、完整资源和安全关闭检查已通过。

v0.2 的本次 Review 修复、关闭补修和功能优先首页已完成本地实现与回归，仍为 **L2 候选，不是已验收发布版**。CI 已接入完整浏览器门禁和四平台原生产物 smoke；交付分支为 `test`，实际远端结果以对应提交的 [GitHub Actions](https://github.com/NzyZzz1998/LocalFileTransfer/actions/workflows/build.yml) 为准，不能沿用旧提交的成功状态。最新本地证据及产物身份见 [进度](docs/progress_v0.2.md)，发布边界见 [待执行清单](docs/release_checklist_v0.2.md)。下列 L3 真机证据尚未取得，不宣称三平台已全部验证：

| 发布前真机组合 | 状态 |
| --- | --- |
| Windows ↔ macOS | 待验证 |
| Windows ↔ Linux | 待验证 |
| macOS ↔ Linux | 待验证 |
| TUN 开启时本地中转 | 待验证 |
| 真机吞吐基线 | 待验证 |

重新构建单文件产物后，可校验它是否与当前源码一致，并输出 SHA256：

```bash
bun run smoke:binary dist/dukou-windows-x64.exe
```

在 macOS/Linux 将参数换成对应原生产物路径。该检查从临时目录启动程序，逐字节核对嵌入资源并正常关闭；在 Windows 上不能替代其他平台的运行证据。源码或产物更新后应重测，不能沿用旧 checksum。

## 部署边界

v0.2 面向局域网本地 HTTP：一台电脑启动服务，其他电脑通过它显示的 LAN 地址打开网页。公网域名、TLS 终止反向代理和 HTTPS/WSS Origin 适配尚未验收，当前版本不宣称可直接用于公网部署。
