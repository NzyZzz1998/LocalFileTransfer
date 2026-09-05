"""Real-browser relay regression; run against an isolated running Dukou server.

Only RTC establishment is stalled to make the fallback path deterministic. The
success case uses the real signaling server, bilateral UI consent, RelayCipher,
transfer engines and browser download. The stale case deliberately supplies an
uncooperative connect promise so ownership guards are tested independently of
server revocation and transport cancellation.
"""

import argparse
from contextlib import contextmanager
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.parse import urlsplit
from urllib.request import urlopen

from playwright.sync_api import sync_playwright

from e2e_transfer_test import find_browser


STALL_RTC_AND_TRACK_SOCKETS = """(() => {
  class StalledPeer {
    constructor() { this.connectionState = 'new'; this.remoteDescription = null; }
    createDataChannel() {
      return { readyState: 'connecting', close() {}, addEventListener() {}, removeEventListener() {} };
    }
    createOffer() { return new Promise(() => {}); }
    close() { this.connectionState = 'closed'; }
  }
  globalThis.RTCPeerConnection = StalledPeer;
  globalThis.__relaySockets = [];
  const NativeWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      if (new URL(String(args[0]), location.href).pathname === '/relay') {
        this.__relayRecord = { socket: this, sentStrings: [], sentFrames: 0 };
        globalThis.__relaySockets.push(this.__relayRecord);
      }
    }
    send(value) {
      if (this.__relayRecord) {
        if (typeof value === 'string') this.__relayRecord.sentStrings.push(value);
        else this.__relayRecord.sentFrames += 1;
      }
      return super.send(value);
    }
  };
})();"""


DELAYED_RELAY_MODULE = """
globalThis.__delayedRelay = { instances: [], sent: [], released: false };
export class RelayTransport extends EventTarget {
  constructor() {
    super();
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.closeCalls = 0;
    globalThis.__delayedRelay.instances.push(this);
  }
  connect() {
    return new Promise(resolve => {
      globalThis.__delayedRelay.release = () => {
        globalThis.__delayedRelay.released = true;
        this.readyState = 'open';
        resolve(this);
      };
    });
  }
  send(value) { globalThis.__delayedRelay.sent.push(value); }
  close() { this.closeCalls += 1; this.readyState = 'closed'; }
}
"""


def configure_context(browser, errors: list[str], label: str, delayed_relay=False):
    context = browser.new_context(
        viewport={"width": 1280, "height": 960}, accept_downloads=True
    )
    context.add_init_script(STALL_RTC_AND_TRACK_SOCKETS)

    def quick_deadlines(route):
        response = route.fetch()
        source = response.text()
        assert "20_000" in source, "Update test timeout seam when PeerSession changes"
        source = source.replace("8_000", "50").replace("20_000", "250")
        if delayed_relay:
            constructor = "constructor(options = {}) {"
            assert constructor in source, "Update the late RTC callback seam when PeerSession changes"
            source = source.replace(constructor, constructor + """
              globalThis.__lateRtcEvents = [];
              globalThis.__emitLateRtc = event => new Promise(resolve => {
                setTimeout(() => {
                  globalThis.__lateRtcEvents.push(event);
                  this.emit(event);
                  resolve();
                }, 0);
              });
            """, 1)
        route.fulfill(
            response=response,
            body=source,
        )

    context.route("**/peer-session.js", quick_deadlines)
    if delayed_relay:
        context.route(
            "**/relay-transport.js",
            lambda route: route.fulfill(
                status=200,
                content_type="application/javascript",
                body=DELAYED_RELAY_MODULE,
            ),
        )
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(f"{label}: {error}"))
    return context, page


def open_home(page, base_url: str):
    page.goto(base_url)
    page.wait_for_load_state("networkidle")
    page.locator("#home-screen").wait_for(state="visible")


def file_payload(name: str, payload: bytes):
    return {"name": name, "mimeType": "application/octet-stream", "buffer": payload}


def connect_pair(sender, receiver, name: str, payload: bytes):
    sender.locator("#choose-sender").click()
    sender.locator("#send-file-input").set_input_files(file_payload(name, payload))
    sender.locator("#create-room-button").click()
    sender.locator("#room-code").filter(has_text=re.compile(r"\d{3}\s\d{3}")).wait_for(
        timeout=5_000
    )
    code = re.sub(r"\D", "", sender.locator("#room-code").inner_text())
    assert len(code) == 6
    receiver.locator("#choose-receiver").click()
    receiver.get_by_label("6 位接收码").fill(code)
    receiver.locator("#join-room-button").click()
    sender.locator("#approve-peer-button").wait_for(state="visible", timeout=5_000)
    sender.locator("#approve-peer-button").click()
    sender.locator("#sender-route-failed").wait_for(state="visible", timeout=5_000)


def approve_relay(sender, receiver):
    # No relay transport or file traffic may exist before BOTH decisions.
    assert sender.evaluate("globalThis.__relaySockets.length") == 0
    assert receiver.evaluate("globalThis.__relaySockets.length") == 0
    sender.locator("#use-relay-button").click()
    receiver.locator("#receiver-relay-consent").wait_for(state="visible", timeout=5_000)
    assert sender.evaluate("globalThis.__relaySockets.length") == 0
    assert receiver.evaluate("globalThis.__relaySockets.length") == 0
    receiver.locator("#approve-relay-button").click()


def return_home(page, screen_id: str):
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator(f"#{screen_id} [data-action='back-home']").first.click()
    page.locator("#home-screen").wait_for(state="visible")


def assert_sockets_closed(page):
    page.wait_for_function(
        "globalThis.__relaySockets.every(record => record.socket.readyState === WebSocket.CLOSED)",
        timeout=5_000,
    )


def verify_real_relay(browser, base_url: str):
    errors: list[str] = []
    sender_context, sender = configure_context(browser, errors, "sender")
    receiver_context, receiver = configure_context(browser, errors, "receiver")
    try:
        open_home(sender, base_url)
        open_home(receiver, base_url)
        payload = bytes((index * 37 + 19) % 256 for index in range(196_613))
        name = "本地中转验证.bin"
        connect_pair(sender, receiver, name, payload)
        approve_relay(sender, receiver)
        receiver.locator("#receiver-file-list").get_by_text(name, exact=True).wait_for(
            timeout=10_000
        )
        receiver.locator("#accept-files-button").click()
        receiver.get_by_role("heading", name="接收完成", exact=True).wait_for(timeout=15_000)
        sender.locator("#sender-progress-percent").get_by_text("100%", exact=True).wait_for(
            timeout=10_000
        )
        for page, prefix in [(sender, "sender"), (receiver, "receiver")]:
            assert page.locator(f"#{prefix}-route-fact").inner_text() == "本地中转"
            assert page.locator(f"#{prefix}-encryption-fact").inner_text() == "应用层加密"
            assert page.evaluate("globalThis.__relaySockets.length") == 1
            assert page.evaluate("globalThis.__relaySockets[0].sentStrings") == []
            assert page.evaluate("globalThis.__relaySockets[0].sentFrames") > 1
        with receiver.expect_download(timeout=10_000) as download_info:
            receiver.get_by_role("button", name=f"保存 {name}", exact=True).click()
        assert Path(download_info.value.path()).read_bytes() == payload
        # Completion alone must close both transport sockets, without losing the
        # receiver's already finalized download result.
        assert_sockets_closed(sender)
        assert_sockets_closed(receiver)
        return_home(sender, "sender-screen")
        return_home(receiver, "receiver-screen")
        assert_sockets_closed(sender)
        assert_sockets_closed(receiver)
        assert not errors, errors
        print("PASS real relay: bilateral UI consent, encrypted frames, byte-exact download, sockets cleaned")
    finally:
        sender_context.close()
        receiver_context.close()


def verify_stale_connect(browser, base_url: str):
    errors: list[str] = []
    sender_context, sender = configure_context(browser, errors, "stale sender", delayed_relay=True)
    receiver_context, receiver = configure_context(browser, errors, "stale receiver")
    try:
        open_home(sender, base_url)
        open_home(receiver, base_url)
        connect_pair(sender, receiver, "old-room.bin", b"old room data")
        approve_relay(sender, receiver)
        sender.wait_for_function("typeof globalThis.__delayedRelay?.release === 'function'")
        return_home(sender, "sender-screen")
        sender.locator("#choose-sender").click()
        sender.locator("#send-file-input").set_input_files(
            file_payload("private-next-room.bin", b"must never reach the old peer")
        )
        # A stale transport is required to be closed while it is STILL connecting.
        assert sender.evaluate("globalThis.__delayedRelay.instances[0].closeCalls") > 0
        sender.evaluate("globalThis.__delayedRelay.release()")
        # Flush promise continuations and one animation frame, not a timing guess.
        sender.evaluate("() => new Promise(resolve => requestAnimationFrame(() => resolve()))")
        assert sender.evaluate("globalThis.__delayedRelay.sent") == []
        assert sender.locator("#sender-prepare").is_visible()
        assert sender.locator("#sender-progress").is_hidden()
        assert sender.locator("#sender-error").is_hidden()
        assert sender.locator("#sender-route-fact").inner_text() != "本地中转"
        sender.locator("#sender-file-list").get_by_text("private-next-room.bin", exact=True).wait_for()
        assert sender.evaluate("globalThis.__delayedRelay.instances.length") == 1
        assert sender.evaluate("globalThis.__delayedRelay.instances[0].readyState") == "closed"
        assert_sockets_closed(receiver)
        assert not errors, errors
        print("PASS stale relay connect: cancellation closes pending transport; old continuation cannot send next-room files")
    finally:
        sender_context.close()
        receiver_context.close()


def verify_disabled_relay(browser, base_url: str):
    errors: list[str] = []
    sender_context, sender = configure_context(browser, errors, "disabled sender")
    receiver_context, receiver = configure_context(browser, errors, "disabled receiver")
    try:
        open_home(sender, base_url)
        open_home(receiver, base_url)
        runtime = sender.evaluate("async () => (await fetch('/api/runtime')).json()")
        assert runtime.get("relayEnabled") is False
        connect_pair(sender, receiver, "direct-only.bin", b"direct only")
        button = sender.locator("#use-relay-button")
        assert button.is_hidden() or button.is_disabled()
        assert sender.locator("#retry-direct-button").is_enabled()
        assert sender.evaluate("globalThis.__relaySockets.length") == 0
        assert receiver.evaluate("globalThis.__relaySockets.length") == 0
        assert not errors, errors
        print("PASS relay disabled: runtime reports false, relay action unavailable, direct retry remains")
    finally:
        sender_context.close()
        receiver_context.close()


def assert_late_rtc_callbacks_ignored(sender, transport_state: str):
    route_before = sender.locator("#sender-route-fact").inner_text()
    timeline_before = sender.locator("#sender-route-timeline").inner_html()
    phase_before = sender.locator("#sender-phase-status").inner_text()
    for event in [
        {"type": "direct_connection", "state": "slow", "elapsedMs": 8_000},
        {"type": "error", "code": "DIRECT_TIMEOUT", "elapsedMs": 20_000},
        {"type": "error", "code": "RTC_NEGOTIATION_FAILED"},
    ]:
        # Schedule each callback on the actual PeerSession instance after the UI
        # has already selected relay; no app handlers or state are replaced.
        sender.evaluate("event => globalThis.__emitLateRtc(event)", event)
        assert sender.locator("#sender-route-fact").inner_text() == route_before, event
        # The timeline is now persistent, including relay phases. Late RTC
        # events must not replace it with a stale direct-route state.
        assert sender.locator("#sender-route-timeline").inner_html() == timeline_before, event
        assert sender.locator("#sender-phase-status").inner_text() == phase_before, event
        assert sender.locator("#sender-route-failed").is_hidden(), event
        assert sender.locator("#sender-error").is_hidden(), event
        assert sender.evaluate("globalThis.__delayedRelay.instances[0].closeCalls") == 0, event
        assert sender.evaluate("globalThis.__delayedRelay.instances[0].readyState") == transport_state, event


def verify_room_file_snapshot(browser, base_url: str):
    errors: list[str] = []
    sender_context, sender = configure_context(browser, errors, "snapshot sender", delayed_relay=True)
    receiver_context, receiver = configure_context(browser, errors, "snapshot receiver")
    try:
        open_home(sender, base_url)
        open_home(receiver, base_url)
        connect_pair(sender, receiver, "approved-room-file.bin", b"approved room bytes")
        approve_relay(sender, receiver)
        sender.wait_for_function("typeof globalThis.__delayedRelay?.release === 'function'")
        assert_late_rtc_callbacks_ignored(sender, "connecting")
        assert sender.locator("#sender-relay-pending").is_visible()
        # The input is intentionally hidden in the waiting stage. Driving it here
        # proves snapshot ownership separately from the ordinary UI restriction.
        sender.locator("#send-file-input").set_input_files(
            file_payload("changed-after-room.bin", b"must not replace the room snapshot")
        )
        sender.evaluate("globalThis.__delayedRelay.release()")
        sender.wait_for_function("globalThis.__delayedRelay.sent.length > 0")
        manifests = sender.evaluate("""() => globalThis.__delayedRelay.sent
          .filter(value => typeof value === 'string').map(value => JSON.parse(value))
          .filter(message => message.type === 'offer_manifest')""")
        assert len(manifests) == 1
        assert [item["name"] for item in manifests[0]["files"]] == ["approved-room-file.bin"]
        assert manifests[0]["files"][0]["size"] == len(b"approved room bytes")
        assert_late_rtc_callbacks_ignored(sender, "open")
        assert sender.evaluate("globalThis.__lateRtcEvents.length") == 6
        return_home(sender, "sender-screen")
        assert sender.evaluate("globalThis.__delayedRelay.instances[0].readyState") == "closed"
        assert_sockets_closed(receiver)
        assert not errors, errors
        print("PASS room file snapshot: changing hidden input during connect cannot replace approved-room manifest")
        print("PASS late RTC callbacks: slow, timeout and negotiation failure cannot change pending or active relay")
    finally:
        sender_context.close()
        receiver_context.close()


@contextmanager
def isolated_server(base_url: str, enabled: bool, relay_disabled: bool):
    if not enabled:
        yield
        return
    address = urlsplit(base_url)
    assert address.scheme == "http" and address.hostname == "127.0.0.1", (
        "--start-server requires a local http://127.0.0.1:<port> base URL"
    )
    port = address.port or 80
    # Never silently use or stop a pre-existing service on this port.
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", port))
    bun = shutil.which("bun")
    assert bun, "Bun is required by --start-server"
    environment = {
        **os.environ,
        "HOST": "127.0.0.1",
        "PORT": str(port),
        "RELAY_ENABLED": "0" if relay_disabled else "1",
    }
    with tempfile.TemporaryFile() as logs:
        process = subprocess.Popen(
            [bun, "src/server.ts"],
            cwd=Path(__file__).resolve().parents[1],
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=logs,
            stderr=logs,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        try:
            deadline = time.monotonic() + 15
            while True:
                if process.poll() is not None:
                    logs.seek(0)
                    raise AssertionError(f"Test server exited: {logs.read().decode(errors='replace')}")
                try:
                    with urlopen(f"{base_url}/api/runtime", timeout=0.5) as response:
                        if response.status == 200:
                            break
                except OSError:
                    pass
                assert time.monotonic() < deadline, "Test server did not become ready"
                time.sleep(0.05)
            yield
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:4127")
    parser.add_argument("--case", choices=["all", "success", "stale", "snapshot", "disabled"], default="all")
    parser.add_argument("--start-server", action="store_true", help="Own and clean one isolated Bun process")
    args = parser.parse_args()
    with isolated_server(args.base_url, args.start_server, args.case == "disabled"), sync_playwright() as playwright:
        options = {"headless": True}
        browser_path = find_browser()
        if browser_path:
            options["executable_path"] = browser_path
        browser = playwright.chromium.launch(**options)
        try:
            if args.case in {"all", "success"}:
                verify_real_relay(browser, args.base_url)
            if args.case in {"all", "stale"}:
                verify_stale_connect(browser, args.base_url)
            if args.case in {"all", "snapshot"}:
                verify_room_file_snapshot(browser, args.base_url)
            if args.case == "disabled":
                verify_disabled_relay(browser, args.base_url)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
