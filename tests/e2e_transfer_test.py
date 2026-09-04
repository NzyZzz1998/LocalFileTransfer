import argparse
import os
from pathlib import Path
import re
import shutil
import time

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:4123")
    args = parser.parse_args()
    payload = bytes((index * 31 + 7) % 256 for index in range(65_537))
    errors: list[str] = []
    SCREENSHOTS.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser_path = find_browser()
        launch_options = {"headless": True}
        if browser_path:
            launch_options["executable_path"] = browser_path
        browser = playwright.chromium.launch(**launch_options)
        sender_context = browser.new_context(viewport={"width": 1440, "height": 960})
        receiver_context = browser.new_context(viewport={"width": 390, "height": 844})
        sender = sender_context.new_page()
        receiver = receiver_context.new_page()
        for page, label in [(sender, "sender"), (receiver, "receiver")]:
            page.on(
                "console",
                lambda message, side=label: errors.append(f"{side}: {message.text}")
                if message.type == "error"
                else None,
            )
            page.on("pageerror", lambda error, side=label: errors.append(f"{side}: {error}"))
            page.goto(args.base_url)
            page.wait_for_load_state("networkidle")

        sender.get_by_role("button", name="发送文件").click()
        sender.locator("#send-file-input").set_input_files(
            files=[
                {
                    "name": "跨系统验证.bin",
                    "mimeType": "application/octet-stream",
                    "buffer": payload,
                }
            ]
        )
        sender.get_by_role("button", name="生成接收码").click()
        sender.locator("#room-code").wait_for(state="visible")
        sender.locator("#room-code").filter(has_text=re.compile(r"\d{3}\s\d{3}")).wait_for(
            timeout=5_000
        )
        code = re.sub(r"\D", "", sender.locator("#room-code").inner_text())
        assert len(code) == 6

        receiver.get_by_role("button", name="接收文件").click()
        receiver.get_by_label("6 位接收码").fill(code)
        receiver.get_by_role("button", name="连接发送方").click()
        sender.get_by_role("heading", name="一台浏览器请求接收").wait_for(timeout=5_000)
        sender.get_by_role("button", name="允许连接").click()

        receiver.locator("#receiver-file-list").get_by_text(
            "跨系统验证.bin", exact=True
        ).wait_for(timeout=10_000)
        receiver.get_by_role("button", name="接收这些文件").click()
        receiver.get_by_role("heading", name="接收完成").wait_for(timeout=15_000)
        sender.locator("#sender-progress-percent").get_by_text("100%", exact=True).wait_for(
            timeout=10_000
        )
        assert sender.locator("#sender-route-fact").inner_text() == "局域网直连"
        assert receiver.locator("#receiver-route-fact").inner_text() == "局域网直连"
        list_temporary_files = """async () => {
          if (!navigator.storage?.getDirectory) return [];
          const root = await navigator.storage.getDirectory();
          const names = [];
          for await (const name of root.keys()) {
            if (name.startsWith('.dukou-') && name.endsWith('.part')) names.push(name);
          }
          return names;
        }"""
        assert len(receiver.evaluate(list_temporary_files)) == 1

        exit_prompts: list[str] = []

        def dismiss_exit(dialog) -> None:
            exit_prompts.append(dialog.message)
            dialog.dismiss()

        receiver.once("dialog", dismiss_exit)
        receiver.get_by_role("button", name="返回首页").click()
        assert exit_prompts == ["尚有接收完成的文件没有保存，返回后将无法恢复。确定返回首页吗？"]
        receiver.get_by_role("heading", name="接收完成").wait_for()

        with receiver.expect_download(timeout=10_000) as download_info:
            receiver.get_by_role("button", name="保存 跨系统验证.bin").click()
        downloaded = Path(download_info.value.path()).read_bytes()
        assert downloaded == payload

        sender.screenshot(path=str(SCREENSHOTS / "sender-real.png"), full_page=True)
        receiver.screenshot(path=str(SCREENSHOTS / "receiver-real.png"), full_page=True)
        assert not errors, errors
        receiver.close()
        cleanup_probe = receiver_context.new_page()
        cleanup_probe.goto(args.base_url)
        for _ in range(50):
            if cleanup_probe.evaluate(list_temporary_files) == []:
                break
            time.sleep(0.02)
        assert cleanup_probe.evaluate(list_temporary_files) == []
        cleanup_probe.close()
        sender_context.close()
        receiver_context.close()
        browser.close()


if __name__ == "__main__":
    main()
