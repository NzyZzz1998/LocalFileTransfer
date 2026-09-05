import os
from pathlib import Path
import re
import shutil
from urllib.parse import urlencode

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "src" / "web" / "index.html"
SCREENSHOTS = ROOT / "artifacts" / "screenshots"
NACL = ROOT / "node_modules" / "tweetnacl" / "nacl-fast.min.js"


def find_browser() -> str | None:
    candidates = [
        os.environ.get("CHROME_PATH"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        shutil.which("google-chrome"),
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
    ]
    return next((candidate for candidate in candidates if candidate and Path(candidate).is_file()), None)


def open_demo(page, role: str) -> list[str]:
    errors: list[str] = []
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.route("**/vendor/tweetnacl.js", lambda route: route.fulfill(path=NACL, content_type="text/javascript"))
    page.goto(f"{HTML.as_uri()}?{urlencode({'demo': role})}")
    page.wait_for_load_state("networkidle")
    return errors


def verify_sender(browser) -> None:
    page = browser.new_page(viewport={"width": 1440, "height": 960})
    errors = open_demo(page, "sender")

    page.get_by_role("heading", name=re.compile("文件不过云.*只过桥")).wait_for()
    page.get_by_text("http://192.168.31.73:3000", exact=True).wait_for()
    page.get_by_role("button", name="发送文件").click()
    page.get_by_role("heading", name="选择要发送的文件").wait_for()
    page.locator("#send-file-input").set_input_files(
        files=[
            {"name": "跨平台说明.txt", "mimeType": "text/plain", "buffer": b"hello"},
            {"name": "layout.sketch", "mimeType": "application/octet-stream", "buffer": b"123456789"},
        ]
    )
    page.get_by_text("跨平台说明.txt", exact=True).wait_for()
    page.get_by_role("button", name="生成接收码").click()
    page.get_by_text("583 204", exact=True).wait_for()
    page.get_by_role("heading", name="一台浏览器请求接收").wait_for(timeout=5_000)
    page.get_by_role("button", name="允许连接").click()
    page.get_by_role("heading", name="直连没有建立").wait_for(timeout=5_000)
    page.get_by_text("DIRECT_TIMEOUT · 20.0s", exact=True).wait_for()
    page.get_by_role("button", name="改用本地中转").click()
    page.get_by_role("heading", name="等待接收方同意改路").wait_for()
    page.get_by_text("对方同意前仍为 0 B。", exact=False).wait_for()
    page.screenshot(path=str(SCREENSHOTS / "sender-desktop.png"), full_page=True)
    assert not errors, errors
    page.close()


def verify_receiver(browser) -> None:
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = open_demo(page, "receiver")

    page.get_by_role("button", name="接收文件").click()
    page.get_by_role("heading", name="输入发送方的接收码").wait_for()
    page.get_by_label("6 位接收码").fill("583204")
    page.get_by_role("button", name="连接发送方").click()
    page.locator("#receiver-relay-consent h3").wait_for(timeout=5_000)
    page.locator("#receiver-relay-consent").get_by_text("0 B", exact=True).wait_for()
    page.get_by_role("button", name="允许本地中转").click()
    page.locator("#receiver-file-list").get_by_text("设计素材包.zip", exact=True).wait_for(timeout=5_000)
    page.get_by_text("本批已通过容量预检", exact=False).wait_for()
    page.get_by_role("button", name="接收这些文件").click()
    page.get_by_role("heading", name="接收完成").wait_for(timeout=8_000)
    page.get_by_role("button", name="保存 设计素材包.zip").wait_for()
    page.screenshot(path=str(SCREENSHOTS / "receiver-narrow.png"), full_page=True)
    assert not errors, errors
    page.close()


def verify_runtime_home(browser, base_url: str) -> None:
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors: list[str] = []
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.goto(base_url)
    page.wait_for_load_state("networkidle")
    lan_url = page.locator("#lan-url")
    lan_url.wait_for()
    assert re.match(r"^http://.+:\d+$", lan_url.inner_text())
    page.get_by_role("button", name="关闭渡口服务").wait_for()
    relay_result = page.evaluate(
        """async () => Promise.race([(async () => {
          const openSocket = (path) => new Promise((resolve, reject) => {
            const socket = new WebSocket(`${location.origin.replace('http', 'ws')}${path}`);
            socket.addEventListener('open', () => resolve(socket), { once: true });
            socket.addEventListener('error', reject, { once: true });
          });
          const next = (socket) => new Promise((resolve) => {
            socket.addEventListener('message', (event) => resolve(JSON.parse(event.data)), { once: true });
          });
          const senderSignal = await openSocket('/ws');
          const receiverSignal = await openSocket('/ws');
          let message = next(senderSignal);
          senderSignal.send(JSON.stringify({ type: 'create_room' }));
          const room = await message;
          const joinRequested = next(senderSignal);
          const joinWaiting = next(receiverSignal);
          receiverSignal.send(JSON.stringify({ type: 'join_room', code: room.code }));
          await Promise.all([joinRequested, joinWaiting]);
          const senderJoined = next(senderSignal);
          const receiverJoined = next(receiverSignal);
          senderSignal.send(JSON.stringify({ type: 'approve_join' }));
          await Promise.all([senderJoined, receiverJoined]);
          const relayRequested = next(receiverSignal);
          senderSignal.send(JSON.stringify({ type: 'request_relay' }));
          await relayRequested;
          const senderReady = next(senderSignal);
          const receiverReady = next(receiverSignal);
          receiverSignal.send(JSON.stringify({ type: 'approve_relay' }));
          const [senderCredential, receiverCredential] = await Promise.all([senderReady, receiverReady]);
          const [{ RelayTransport }, { SenderEngine, ReceiverEngine }] = await Promise.all([
            import('/relay-transport.js'),
            import('/transfer.js'),
          ]);
          const senderTransport = new RelayTransport({ token: senderCredential.token });
          const receiverTransport = new RelayTransport({ token: receiverCredential.token });
          await Promise.all([senderTransport.connect(), receiverTransport.connect()]);
          let offered;
          let received = [];
          const receiver = new ReceiverEngine(receiverTransport, {
            createSink: async () => ({
              bytesWritten: 0,
              async write(chunk) { received.push(...chunk); this.bytesWritten += chunk.byteLength; },
              async finalize() { return new Blob([Uint8Array.from(received)]); },
              async abort() { received = []; this.bytesWritten = 0; },
            }),
            onManifest: (manifest) => { offered = manifest; },
          });
          const sender = new SenderEngine(senderTransport);
          const result = sender.send([new File([new TextEncoder().encode('encrypted relay ok')], '验证.txt')]);
          while (!offered) await new Promise((resolve) => setTimeout(resolve, 0));
          receiver.accept();
          await result;
          senderSignal.close();
          receiverSignal.close();
          senderTransport.close();
          receiverTransport.close();
          return { state: receiver.state, text: new TextDecoder().decode(Uint8Array.from(received)) };
        })(), new Promise((_, reject) => setTimeout(() => reject(new Error('relay browser timeout')), 10000))])"""
    )
    assert relay_result == {"state": "completed", "text": "encrypted relay ok"}
    page.screenshot(path=str(SCREENSHOTS / "runtime-home-v0.2.png"), full_page=True)
    assert not errors, errors
    page.close()


def main() -> None:
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser_path = find_browser()
        launch_options = {"headless": True}
        if browser_path:
            launch_options["executable_path"] = browser_path
        browser = playwright.chromium.launch(**launch_options)
        verify_sender(browser)
        verify_receiver(browser)
        if runtime_url := os.environ.get("DUKOU_TEST_URL"):
            verify_runtime_home(browser, runtime_url)
        browser.close()


if __name__ == "__main__":
    main()
