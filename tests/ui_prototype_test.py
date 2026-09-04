import os
from pathlib import Path
import re
import shutil
from urllib.parse import urlencode

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "src" / "web" / "index.html"
SCREENSHOTS = ROOT / "artifacts" / "screenshots"


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
    page.goto(f"{HTML.as_uri()}?{urlencode({'demo': role})}")
    page.wait_for_load_state("networkidle")
    return errors


def verify_sender(browser) -> None:
    page = browser.new_page(viewport={"width": 1440, "height": 960})
    errors = open_demo(page, "sender")

    page.get_by_role("heading", name=re.compile("文件不过云.*只过桥")).wait_for()
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
    page.locator("#sender-connected").get_by_text("等待对方确认文件", exact=True).wait_for()
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
    page.locator("#receiver-file-list").get_by_text("设计素材包.zip", exact=True).wait_for(timeout=5_000)
    page.get_by_role("button", name="接收这些文件").click()
    page.get_by_role("heading", name="接收完成").wait_for(timeout=8_000)
    page.get_by_role("button", name="保存 设计素材包.zip").wait_for()
    page.screenshot(path=str(SCREENSHOTS / "receiver-narrow.png"), full_page=True)
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
        browser.close()


if __name__ == "__main__":
    main()
