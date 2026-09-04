# 渡口 DUKOU

两台电脑只需打开同一个网页，用 6 位接收码建立 WebRTC DataChannel，在局域网中点对点传文件。文件名和文件内容不经过信令服务器；服务端只负责短时房间和 WebRTC 连接信息交换。

## 本地运行

安装 [Bun](https://bun.sh/) 1.3 或更高版本后，可直接从源码启动：

```bash
bun start
```

也可以先编译为当前操作系统的单文件程序。Windows 示例：

```powershell
bun run compile
$env:HOST = "0.0.0.0"
$env:PORT = "3000"
.\dist\dukou.exe
```

默认监听 `0.0.0.0:3000`。在运行服务的电脑和同一局域网内的另一台电脑上，分别用浏览器打开：

```text
http://<运行服务电脑的局域网 IP>:3000
```

一端选择“发送文件”，另一端选择“接收文件”。发送方把 6 位码告诉接收方，并批准接收请求；接收方核对文件清单后才会开始传输。接收电脑不需要安装客户端。

若另一台电脑无法打开页面，请确认两台设备能互访、没有使用隔离设备的访客 Wi-Fi，并允许系统防火墙放行 TCP 3000 端口。若页面可以打开、但一直无法建立局域网直连，请暂时关闭 VPN/TUN 验证，或在代理工具中将局域网私有地址设置为直连。

终端出现 `渡口已启动：http://0.0.0.0:3000/` 后，实际访问地址仍应把 `0.0.0.0` 换成运行电脑的局域网 IP。`HOST` 和 `PORT` 均可省略；默认值分别为 `0.0.0.0` 和 `3000`。

## 开发与构建

```bash
bun run dev
bun test
bun run build
bun run compile
```

- `bun run build` 生成 Bun bundle。
- `bun run compile` 生成当前操作系统的单文件可执行程序；macOS、Linux 应在对应系统上分别执行该命令。

真实浏览器 E2E 需要 Python Playwright 和 Chrome。首次运行先安装测试依赖：

```bash
python -m pip install playwright
python -m playwright install chromium
```

然后在一个终端启动测试服务：

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "4123"
bun start
```

再在另一个终端执行：

```powershell
python tests/e2e_transfer_test.py --base-url http://127.0.0.1:4123
```

脚本会查找常见位置中的 Chrome/Chromium，找不到时使用 Playwright 自带的 Chromium。若浏览器在其他位置，可先设置 `CHROME_PATH` 环境变量。

## 工作边界

- 一次房间仅一名发送方和一名接收方，10 分钟过期。
- 发送方批准浏览器连接前不交换 WebRTC offer；接收方批准文件清单前不发送文件字节。
- DataChannel 可靠、有序，文件按 16 KiB 分块顺序传输，并使用缓存水位背压。
- 接收端优先写入 OPFS；不可用时以内存暂存，默认单文件上限 256 MiB。
- 未配置 TURN。无法建立直连时会失败，不会静默把文件上传到服务器。
- 服务端会看到连接时间、来源地址、房间码以及 SDP/ICE 网络元数据，但不接收文件清单或文件内容。

## 当前验证范围

自动化已覆盖信令状态机、Origin 与安全头、真实 WebSocket、WebRTC 会话、分块/背压、OPFS/内存暂存、浏览器下载字节一致性，以及桌面/窄屏 UI。当前真实浏览器验证在 Windows Chrome 上完成。

Windows、macOS、Linux 三组真机互传矩阵仍属于发布前验证项；本仓库没有执行公网部署，也没有启用 TURN 或云端文件中转。

| 发布前真机组合 | 状态 |
| --- | --- |
| Windows ↔ macOS | 待验证 |
| Windows ↔ Linux | 待验证 |
| macOS ↔ Linux | 待验证 |

## 部署边界

v0.1 交付的是局域网本地 HTTP MVP：在一台电脑启动服务，其他电脑通过它的局域网 IP 打开网页。公网域名、TLS 终止反向代理和 HTTPS/WSS Origin 适配尚未验收，当前版本不宣称可以直接用于公网部署。
