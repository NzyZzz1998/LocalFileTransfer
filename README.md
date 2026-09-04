# 渡口 DUKOU

渡口是一个面向桌面电脑的局域网文件快传工具。一台电脑运行渡口，发送端和接收端都只需用 Chrome、Chromium 或 Edge 打开同一个局域网页面，再用 6 位接收码配对。

v0.2 优先使用 WebRTC 点对点直连；20 秒内无法建立安全直连时，发送方可以申请经过渡口进程内存转发。中转必须由接收方再次同意，文件在浏览器内使用临时密钥加密，服务端不落盘，也不会静默切换路线。

> 当前只支持桌面端使用场景，尚未验证手机浏览器，因此不提供二维码入口。

## 本地运行

安装 [Bun](https://bun.sh/) 1.3 或更高版本后：

```bash
bun start
```

也可以编译为当前操作系统的单文件程序。Windows 示例：

```powershell
bun run compile
.\dist\dukou.exe
```

默认监听 `0.0.0.0:3000`。启动后，终端和首页都会显示推荐的局域网地址（例如 `http://192.168.1.20:3000`），直接复制给另一台电脑即可，不需要自己查 IP 或替换 `0.0.0.0`。

一端选择“发送文件”，另一端选择“接收文件”。发送方把 6 位码告诉接收方并批准连接；接收方核对文件清单后才会开始传输。接收电脑无需安装客户端。

若另一台电脑无法打开页面，请确认两台设备位于可互访的同一局域网、没有使用隔离设备的访客 Wi-Fi，并允许系统防火墙放行 TCP 3000 端口。VPN/TUN 可能干扰 WebRTC 直连；v0.2 会在超时后提供双方确认的本地中转出口。

运行服务的电脑通过 `localhost` 打开首页时，可以使用“关闭渡口服务”；局域网中的其他电脑看不到该入口，也不能远程调用关闭接口。

## 传输与安全边界

- 未配对房间创建 10 分钟后失效；配对后不再受这段建房 TTL 影响。
- 发送方批准连接前不交换 WebRTC offer；接收方批准文件清单前不发送文件字节。
- 直连使用可靠、有序的 WebRTC DataChannel，文件不经过渡口服务进程。
- 本地中转需发送方申请、接收方同意，使用一次性角色凭据与临时 Curve25519/XSalsa20-Poly1305 会话密钥；服务端只转发不透明二进制帧，不保存文件。
- 发送端进度以接收方确认的字节数为准，并显示当前速度、平均速度、用时与 ETA。
- 接收端优先使用 OPFS；不可用时以内存暂存，单文件和整批文件上限均为 256 MiB。
- 中转加密可以防止普通被动监听或日志直接看到文件内容，但局域网 HTTP 无法抵抗网页被主动替换、恶意渡口程序或主动中间人，不应视为与 WebRTC DTLS 等价。
- 服务端仍能看到连接时间、来源地址、房间码及必要的连接元数据；诊断复制不包含房间码、IP、SDP、文件名、路径或文件内容。

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
python -m pip install playwright
python -m playwright install chromium
```

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

脚本会查找常见位置中的 Chrome/Chromium，找不到时使用 Playwright 自带的 Chromium。浏览器在其他位置时可设置 `CHROME_PATH`。

## 当前验证范围

自动化已覆盖信令状态机、Origin 与安全头、真实 WebSocket、WebRTC 会话、8/20 秒超时、加密中转、篡改与重放拒绝、ACK 进度、OPFS/内存预检、浏览器下载字节一致性，以及桌面/窄屏 UI。Windows x64 单文件构建已完成。

下列 L3 真机证据尚未取得，因此 v0.2 当前是“实现完成、兼容性待补证”，不宣称三平台已全部验证：

| 发布前真机组合 | 状态 |
| --- | --- |
| Windows ↔ macOS | 待验证 |
| Windows ↔ Linux | 待验证 |
| macOS ↔ Linux | 待验证 |
| TUN 开启时本地中转 | 待验证 |
| 真机吞吐基线 | 待验证 |

## 部署边界

v0.2 面向局域网本地 HTTP：一台电脑启动服务，其他电脑通过它显示的 LAN 地址打开网页。公网域名、TLS 终止反向代理和 HTTPS/WSS Origin 适配尚未验收，当前版本不宣称可直接用于公网部署。
