"""Real-page LAN address, connection timeline and privacy-safe diagnostic tests.

Fixtures replace only /api/runtime or native browser APIs. No application,
PeerSession, transfer engine or demonstration implementation is substituted.
Run with --start-server to own and clean one isolated Bun server per scenario.
"""

import argparse
import json
import re
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

from e2e_relay_lifecycle_test import file_payload, isolated_server, open_home, return_home
from e2e_recovery_preflight_test import TRACK_BOUNDARIES, browser_fault_script, download_result
from e2e_transfer_test import find_browser


def lan_urls(base_url):
    port = urlsplit(base_url).port or 80
    return [f"http://{host}:{port}" for host in ["192.168.50.10", "10.12.0.7", "198.18.0.1"]]

NATIVE_RTC_GATES = """(() => {
  const config = CONFIG;
  globalThis.__offerGates = [];
  globalThis.__statsGates = [];
  const prototype = RTCPeerConnection.prototype;
  const offer = prototype.createOffer;
  const stats = prototype.getStats;
  if (config.offer) prototype.createOffer = async function(...args) {
    await new Promise(resolve => globalThis.__offerGates.push(resolve));
    return offer.apply(this, args);
  };
  prototype.getStats = async function(...args) {
    const reports = await stats.apply(this, args);
    if (config.stats) await new Promise(resolve => globalThis.__statsGates.push(resolve));
    if (config.unsafe) return new Map([...reports].map(([id, report]) => [id,
      ['local-candidate', 'remote-candidate'].includes(report.type)
        ? { ...report, candidateType: 'relay', address: '203.0.113.77',
            ip: '203.0.113.77', url: 'turn:secret.invalid', sdp: 'a=ice-ufrag:private-sdp' }
        : report]));
    return reports;
  };
})();"""


def configure_context(browser, errors, label="page", clipboard=True, runtime=None, gate_offer=False, gate_stats=False, unsafe=False):
    context = browser.new_context(viewport={"width": 1280, "height": 960}, accept_downloads=True)
    context.add_init_script("""(() => {
      globalThis.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: ENABLED ? { writeText: async text => { globalThis.__copied.push(text); } } : undefined });
    })();""".replace("ENABLED", "true" if clipboard else "false"))
    context.add_init_script(NATIVE_RTC_GATES.replace("CONFIG", json.dumps({
        "offer": gate_offer, "stats": gate_stats, "unsafe": unsafe,
    })))
    if runtime is not None:
        def runtime_response(route):
            if runtime == "unavailable":
                route.fulfill(status=503, content_type="application/json", body='{"error":"unavailable"}')
                return
            response = route.fetch()
            data = response.json()
            data.update(runtime)
            route.fulfill(response=response, json=data)
        context.route("**/api/runtime", runtime_response)
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(f"{label}: {error}"))
    return context, page


def copied_text(page, button):
    previous = page.evaluate("globalThis.__copied.length")
    button.click()
    page.wait_for_function("count => globalThis.__copied.length > count", arg=previous, timeout=5_000)
    return page.evaluate("globalThis.__copied.at(-1)")


def verify_lan_candidates(browser, base_url):
    errors = []
    urls = lan_urls(base_url)
    context, page = configure_context(browser, errors, runtime={"lanUrls": urls, "recommendedUrl": urls[0]})
    try:
        open_home(page, base_url)
        expect(page.locator("#lan-url")).to_have_text(urls[0])
        assert copied_text(page, page.locator("#copy-lan-url")) == urls[0]
        for url in urls[1:]:
            # Removing the complete runtime list consumer must make this fail.
            expect(page.locator("#home-screen")).to_contain_text(url, timeout=3_000)
            button = page.locator(f'[data-copy-lan-url="{url}"]')
            assert copied_text(page, button) == url
        assert not errors, errors
        print("PASS LAN candidates: recommendation and every alternate are visible and independently copyable", flush=True)
    finally:
        context.close()


def verify_lan_unavailable(browser, base_url, failed_request):
    errors = []
    runtime = "unavailable" if failed_request else {"lanUrls": [], "recommendedUrl": base_url}
    context, page = configure_context(browser, errors, runtime=runtime)
    try:
        open_home(page, base_url)
        status = page.locator("#lan-access-status")
        expect(status).to_be_visible()
        if failed_request:
            expect(status).to_contain_text(re.compile("读取失败|获取失败|暂时无法|暂无法|未能读取|无法读取"))
            assert "未找到" not in status.inner_text() and "没有网卡" not in status.inner_text()
        else:
            expect(status).to_contain_text("仅本机")
            expect(page.locator("#lan-url")).to_contain_text("127.0.0.1")
        button = page.locator("#copy-lan-url")
        assert button.is_disabled() or button.is_hidden(), "Localhost must never be copied as a LAN destination"
        assert page.locator("[data-copy-lan-url]").count() == 0
        assert page.evaluate("globalThis.__copied") == []
        assert not errors, errors
        print(f"PASS LAN {'request failure' if failed_request else 'empty list'}: honest status, no false LAN copy", flush=True)
    finally:
        context.close()


def verify_lan_copy_fallback(browser, base_url):
    errors = []
    urls = lan_urls(base_url)
    context, page = configure_context(browser, errors, clipboard=False,
        runtime={"lanUrls": urls, "recommendedUrl": urls[0]})
    try:
        open_home(page, base_url)
        for url, button in [(urls[0], page.locator("#copy-lan-url")),
                            (urls[1], page.locator(f'[data-copy-lan-url="{urls[1]}"]'))]:
            button.click()
            fallback = page.locator("#copy-fallback-text")
            expect(fallback).to_be_visible()
            expect(fallback).to_have_value(url)
            assert fallback.evaluate("element => element.readOnly")
            assert fallback.evaluate("element => element.selectionEnd - element.selectionStart") == len(url)
            page.keyboard.press("Escape")
        assert not errors, errors
        print("PASS unavailable Clipboard API: recommended/alternate URL gets selected read-only manual-copy text", flush=True)
    finally:
        context.close()


def join_without_approval(sender, receiver, name, payload):
    sender.locator("#choose-sender").click()
    sender.locator("#send-file-input").set_input_files(file_payload(name, payload))
    sender.locator("#create-room-button").click()
    sender.locator("#room-code").filter(has_text=re.compile(r"\d{3}\s\d{3}")).wait_for(timeout=5_000)
    code = re.sub(r"\D", "", sender.locator("#room-code").inner_text())
    receiver.locator("#choose-receiver").click()
    receiver.get_by_label("6 位接收码").fill(code)
    receiver.locator("#join-room-button").click()
    sender.locator("#approve-peer-button").wait_for(state="visible", timeout=5_000)
    return code


def expect_stage(page, prefix, step, state="active"):
    timeline = page.locator(f"#{prefix}-route-timeline")
    expect(timeline).to_be_visible()
    element = timeline.locator(f'[data-step="{step}"]')
    expect(element).to_have_class(re.compile(rf"\b{state}\b"))
    if state == "active":
        expect(element).to_have_attribute("aria-current", "step")
    assert timeline.locator("li").count() == 5


def diagnostic_button(page, prefix):
    return page.locator("#copy-diagnostic-button" if prefix == "sender" else "#receiver-copy-diagnostic-button")


def parse_diagnostic(text, forbidden):
    data = json.loads(text)
    allowed = {"version", "os", "browser", "stage", "elapsedMs", "totalElapsedMs", "failedStage",
               "signalingState", "iceState", "connectionState", "localCandidateType", "remoteCandidateType", "errorCode"}
    assert set(data) == allowed, f"Diagnostic must include the agreed state contract and no arbitrary context: {set(data)}"
    for secret in [*forbidden, "203.0.113.77", "192.168.50.10", "127.0.0.1", "private-sdp", "secret.invalid", "Mozilla/"]:
        assert secret not in text, f"Diagnostic disclosed {secret!r}"
    assert not re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", text), "Diagnostics must not contain IP addresses"
    assert data["version"] == "0.2.0"
    assert isinstance(data["os"], str) and 0 < len(data["os"]) < 32
    assert isinstance(data["browser"], str) and 0 < len(data["browser"]) < 32
    assert isinstance(data["elapsedMs"], (int, float)) and data["elapsedMs"] >= 0
    assert isinstance(data["totalElapsedMs"], (int, float)) and data["totalElapsedMs"] >= data["elapsedMs"]
    return data


def verify_timeline_success(browser, base_url):
    errors = []
    sender_context, sender = configure_context(browser, errors, "sender", gate_offer=True, gate_stats=True)
    receiver_context, receiver = configure_context(browser, errors, "receiver", gate_stats=True)
    try:
        sender.clock.install()
        receiver.clock.install()
        open_home(sender, base_url)
        open_home(receiver, base_url)
        name, payload = "private-timeline-name.bin", bytes((index * 17 + 3) % 256 for index in range(32_779))
        code = join_without_approval(sender, receiver, name, payload)
        for page, prefix in [(sender, "sender"), (receiver, "receiver")]:
            expect_stage(page, prefix, "signal", "done")
            expect_stage(page, prefix, "approval")
        sender.locator("#approve-peer-button").click()
        sender.wait_for_function("() => globalThis.__offerGates.length > 0", timeout=5_000)
        for page, prefix in [(sender, "sender"), (receiver, "receiver")]:
            expect_stage(page, prefix, "route")
            page.clock.fast_forward(8_100)
            expect(page.locator(f"#{prefix}-screen")).to_contain_text("连接比平时慢")
            expect_stage(page, prefix, "route")
        sender.evaluate("globalThis.__offerGates.splice(0).forEach(resolve => resolve())")
        for page, prefix in [(sender, "sender"), (receiver, "receiver")]:
            page.wait_for_function("() => globalThis.__statsGates.length > 0", timeout=5_000)
            expect_stage(page, prefix, "verify")
        sender.evaluate("globalThis.__statsGates.splice(0).forEach(resolve => resolve())")
        receiver.evaluate("globalThis.__statsGates.splice(0).forEach(resolve => resolve())")
        receiver.locator("#receiver-file-list").get_by_text(name, exact=True).wait_for(timeout=10_000)
        for page, prefix in [(sender, "sender"), (receiver, "receiver")]:
            timeline = page.locator(f"#{prefix}-route-timeline")
            expect(timeline).to_be_visible()
            expect(timeline.locator('[data-step="ready"]')).to_have_class(re.compile(r"\b(done|active)\b"))
            assert timeline.locator(".failed").count() == 0
            data = parse_diagnostic(copied_text(page, diagnostic_button(page, prefix)), [name, code])
            assert data["errorCode"] is None
            assert data["signalingState"] == "open"
            assert data["connectionState"] == "connected"
            assert data["localCandidateType"] == "host" and data["remoteCandidateType"] == "host"
        download_result(sender, receiver, name, payload)
        expect(sender.locator("#sender-progress-bytes").locator("..")).to_contain_text("对方已接收")
        assert not errors, errors
        print("PASS both timelines: approval, route, real slow state, verification, ready; ACK label and direct download", flush=True)
    finally:
        sender_context.close()
        receiver_context.close()


def verify_failure_diagnostics(browser, base_url, timeout=False, clipboard=True):
    errors = []
    sender_context, sender = configure_context(browser, errors, "sender", clipboard=clipboard, gate_offer=timeout, unsafe=not timeout)
    receiver_context, receiver = configure_context(browser, errors, "receiver", clipboard=clipboard, unsafe=not timeout)
    try:
        sender.clock.install()
        receiver.clock.install()
        open_home(sender, base_url)
        open_home(receiver, base_url)
        name = "never-copy-private-name.bin"
        code = join_without_approval(sender, receiver, name, b"never disclose these bytes")
        sender.locator("#approve-peer-button").click()
        if timeout:
            sender.wait_for_function("() => globalThis.__offerGates.length > 0", timeout=5_000)
            sender.clock.fast_forward(20_100)
            receiver.clock.fast_forward(20_100)
        sender.locator("#sender-route-failed").wait_for(state="visible", timeout=5_000)
        expected_error = "DIRECT_TIMEOUT" if timeout else "DIRECT_UNSAFE_ROUTE"
        expect(sender.locator("#sender-route-failed .decision-code")).to_contain_text(expected_error)
        for page, prefix in [(sender, "sender"), (receiver, "receiver")]:
            expect_stage(page, prefix, "route" if timeout else "verify", "failed")
            button = diagnostic_button(page, prefix)
            if clipboard:
                text = copied_text(page, button)
            else:
                button.click()
                fallback = page.locator("#copy-fallback-text")
                expect(fallback).to_be_visible()
                text = fallback.input_value()
                assert fallback.evaluate("element => element.readOnly")
                assert fallback.evaluate("element => element.selectionEnd - element.selectionStart") == len(text)
            data = parse_diagnostic(text, [name, code])
            assert data["stage"] == "direct_failed"
            assert data["failedStage"] == ("finding_route" if timeout else "verifying_channel")
            assert data["errorCode"] == expected_error
            assert data["signalingState"] == "open"
            assert data["iceState"] in {"new", "checking", "connected", "completed", "disconnected", "failed", "closed"}
            assert data["connectionState"] in {"new", "connecting", "connected", "disconnected", "failed", "closed"}
            if timeout:
                assert data["elapsedMs"] >= 20_000
            else:
                assert data["elapsedMs"] < 20_000
                assert data["localCandidateType"] == "relay" and data["remoteCandidateType"] == "relay"
        if not timeout and clipboard:
            sender.locator("#use-relay-button").click()
            receiver.locator("#receiver-relay-consent").wait_for(state="visible", timeout=5_000)
            for panel in [sender.locator("#sender-relay-pending"), receiver.locator("#receiver-relay-consent")]:
                expect(panel).to_contain_text(re.compile("运行渡口服务的电脑.*内存"))
        assert not errors, errors
        print(f"PASS {'timeout' if timeout else 'unsafe-route'} diagnostics: both actual failure timelines, true states/timing, redacted {'clipboard' if clipboard else 'manual text'}", flush=True)
    finally:
        sender_context.close()
        receiver_context.close()


def verify_retry_file_snapshot(browser, base_url):
    errors = []
    sender_context, sender = configure_context(browser, errors, "sender")
    receiver_context, receiver = configure_context(browser, errors, "receiver")
    sender_context.add_init_script("""(() => {
      const stats = RTCPeerConnection.prototype.getStats;
      let calls = 0;
      RTCPeerConnection.prototype.getStats = async function(...args) {
        const reports = await stats.apply(this, args);
        if (++calls !== 1) return reports;
        return new Map([...reports].map(([id, report]) => [id,
          ['local-candidate', 'remote-candidate'].includes(report.type)
            ? { ...report, candidateType: 'relay' } : report]));
      };
    })();""")
    try:
        open_home(sender, base_url)
        open_home(receiver, base_url)
        name, payload = "approved-retry-file.bin", b"original approved snapshot"
        original_code = join_without_approval(sender, receiver, name, payload)
        sender.locator("#approve-peer-button").click()
        sender.locator("#sender-route-failed").wait_for(state="visible", timeout=5_000)
        sender.locator("#send-file-input").set_input_files(file_payload("private-next-selection.bin", b"not approved for this round"))
        sender.locator("#retry-direct-button").click()
        sender.wait_for_function("previous => document.querySelector('#room-code').textContent.replace(/\\D/g, '') !== previous", arg=original_code)
        sender.locator("#room-code").filter(has_text=re.compile(r"\d{3}\s\d{3}")).wait_for(timeout=5_000)
        retry_code = re.sub(r"\D", "", sender.locator("#room-code").inner_text())
        return_home(receiver, "receiver-screen")
        receiver.locator("#choose-receiver").click()
        receiver.get_by_label("6 位接收码").fill(retry_code)
        receiver.locator("#join-room-button").click()
        sender.locator("#approve-peer-button").click()
        receiver.locator("#receiver-file-list li").first.wait_for(timeout=10_000)
        expect(receiver.locator("#receiver-file-list")).to_contain_text(name, timeout=3_000)
        assert "private-next-selection.bin" not in receiver.locator("#receiver-file-list").inner_text()
        download_result(sender, receiver, name, payload)
        assert not errors, errors
        print("PASS direct retry: fresh room keeps approved file snapshot despite a later hidden-input selection", flush=True)
    finally:
        sender_context.close()
        receiver_context.close()


def verify_active_failure_snapshot(browser, base_url):
    errors = []
    sender_context, sender = configure_context(browser, errors, "sender")
    receiver_context, receiver = configure_context(browser, errors, "receiver")
    sender_context.add_init_script(TRACK_BOUNDARIES)
    receiver_context.add_init_script(TRACK_BOUNDARIES)
    receiver_context.add_init_script(browser_fault_script(storage_fault="drop-active"))
    try:
        open_home(sender, base_url)
        open_home(receiver, base_url)
        name = "private-active-failure.bin"
        code = join_without_approval(sender, receiver, name, bytes(index % 256 for index in range(262_147)))
        sender.locator("#approve-peer-button").click()
        receiver.locator("#receiver-file-list").get_by_text(name, exact=True).wait_for(timeout=10_000)
        receiver.locator("#accept-files-button").click()
        receiver.wait_for_function("() => globalThis.__closedActivePeer === true", timeout=10_000)
        expect(sender.locator("#sender-error")).to_be_visible(timeout=10_000)
        for page, prefix in [(sender, "sender"), (receiver, "receiver")]:
            data = parse_diagnostic(copied_text(page, diagnostic_button(page, prefix)), [name, code])
            print(f"INFO {prefix} active failure: {json.dumps(data, sort_keys=True)}", flush=True)
            assert data["stage"] == "failed", f"A terminated transfer must not keep a {data['stage']} diagnostic"
            assert data["failedStage"] == "transferring"
            assert data["errorCode"].startswith("DIRECT_") or data["errorCode"] in {"PEER_LEFT", "TRANSFER_FAILED"}, data
            expect_stage(page, prefix, "ready", "failed")
        for page in [sender, receiver]:
            page.wait_for_function("() => globalThis.__signalSockets.at(-1).readyState === WebSocket.CLOSED", timeout=5_000)
        assert not errors, errors
        print("PASS active direct failure: both diagnostics retain terminal failure and actual direct error, not transferring", flush=True)
    finally:
        sender_context.close()
        receiver_context.close()


def verify_early_signal_failure(browser, base_url):
    errors = []
    context, page = configure_context(browser, errors)
    context.add_init_script("""(() => {
      const NativeWebSocket = WebSocket;
      globalThis.WebSocket = class extends NativeWebSocket {
        constructor(url, ...args) {
          const target = new URL(url, location.href);
          if (target.pathname === '/ws') target.pathname = '/test-unavailable-signaling';
          super(target.href, ...args);
        }
      };
    })();""")
    try:
        open_home(page, base_url)
        page.locator("#choose-sender").click()
        expect(page.locator("#sender-error")).to_be_visible(timeout=5_000)
        data = parse_diagnostic(copied_text(page, diagnostic_button(page, "sender")), [])
        assert data["stage"] == "failed"
        assert data["errorCode"] == "SIGNAL_OFFLINE"
        assert data["signalingState"] == "closed"
        assert page.locator("#sender-prepare").is_visible()
        assert not errors, errors
        print("PASS early signaling failure: visible error and copyable offline diagnostic before any room exists", flush=True)
    finally:
        context.close()


def verify_relay_diagnostic_phases(browser, base_url):
    errors = []
    sender_context, sender = configure_context(browser, errors, "sender", unsafe=True)
    receiver_context, receiver = configure_context(browser, errors, "receiver", unsafe=True)
    try:
        open_home(sender, base_url)
        open_home(receiver, base_url)
        name, payload = "private-relay-phase.bin", b"relay phases must replace the earlier direct failure"
        code = join_without_approval(sender, receiver, name, payload)
        sender.locator("#approve-peer-button").click()
        sender.locator("#sender-route-failed").wait_for(state="visible", timeout=5_000)
        for attempt in range(2):
            sender.locator("#use-relay-button").click()
            receiver.locator("#receiver-relay-consent").wait_for(state="visible", timeout=5_000)
            for page, prefix in [(sender, "sender"), (receiver, "receiver")]:
                data = parse_diagnostic(copied_text(page, diagnostic_button(page, prefix)), [name, code])
                assert data["stage"] == "relay_pending" and data["errorCode"] is None
                expect_stage(page, prefix, "route")
            if attempt == 0:
                receiver.locator("#reject-relay-button").click()
                sender.locator("#sender-route-failed").wait_for(state="visible", timeout=5_000)
                for page, prefix in [(sender, "sender"), (receiver, "receiver")]:
                    data = parse_diagnostic(copied_text(page, diagnostic_button(page, prefix)), [name, code])
                    assert data["errorCode"] == "RELAY_DECLINED"
                    assert data["stage"] == "failed" and data["failedStage"] == "relay_pending"
            else:
                receiver.locator("#approve-relay-button").click()
        receiver.locator("#receiver-file-list").get_by_text(name, exact=True).wait_for(timeout=10_000)
        for page, prefix in [(sender, "sender"), (receiver, "receiver")]:
            data = parse_diagnostic(copied_text(page, diagnostic_button(page, prefix)), [name, code])
            assert data["stage"] == "relay_ready" and data["errorCode"] is None
            expect(page.locator(f"#{prefix}-route-timeline [data-step='verify']")).to_contain_text("中转")
        download_result(sender, receiver, name, payload)
        for page, prefix in [(sender, "sender"), (receiver, "receiver")]:
            data = parse_diagnostic(copied_text(page, diagnostic_button(page, prefix)), [name, code])
            assert data["stage"] == "completed" and data["errorCode"] is None
        assert not errors, errors
        print("PASS relay diagnostics: pending, declined, pending again, ready and completed supersede direct failure", flush=True)
    finally:
        sender_context.close()
        receiver_context.close()


def verify_terminal_route_actions(browser, base_url):
    errors = []
    sender_context, sender = configure_context(browser, errors, "sender", gate_offer=True)
    receiver_context, receiver = configure_context(browser, errors, "receiver")
    try:
        sender.clock.install()
        receiver.clock.install()
        open_home(sender, base_url)
        open_home(receiver, base_url)
        code = join_without_approval(sender, receiver, "retained-room-file.bin", b"retry after the old peer leaves")
        sender.locator("#approve-peer-button").click()
        sender.wait_for_function("() => globalThis.__offerGates.length > 0", timeout=5_000)
        sender.clock.fast_forward(20_100)
        receiver.clock.fast_forward(20_100)
        sender.locator("#sender-route-failed").wait_for(state="visible", timeout=5_000)
        return_home(receiver, "receiver-screen")
        expect(sender.locator("#sender-error")).to_be_visible(timeout=5_000)
        relay = sender.locator("#use-relay-button")
        assert relay.is_disabled() or relay.is_hidden(), "A departed peer cannot approve relay; do not offer a dead action"
        expect(sender.locator("#retry-direct-button")).to_be_enabled()
        sender.locator("#retry-direct-button").click()
        sender.wait_for_function("previous => document.querySelector('#room-code').textContent.replace(/\\D/g, '') !== previous", arg=code)
        sender.locator("#room-code").filter(has_text=re.compile(r"\d{3}\s\d{3}")).wait_for(timeout=5_000)
        assert re.sub(r"\D", "", sender.locator("#room-code").inner_text()) != code
        assert not errors, errors
        print("PASS departed-peer actions: no dead relay button; retry still creates a fresh room", flush=True)
    finally:
        sender_context.close()
        receiver_context.close()


def verify_completed_disconnect(browser, base_url):
    errors = []
    sender_context, sender = configure_context(browser, errors, "sender")
    receiver_context, receiver = configure_context(browser, errors, "receiver")
    sender_context.add_init_script("""(() => {
      const createChannel = RTCPeerConnection.prototype.createDataChannel;
      RTCPeerConnection.prototype.createDataChannel = function(...args) {
        const channel = createChannel.apply(this, args);
        channel.addEventListener('close', () => { globalThis.__completedChannelClosed = true; });
        return channel;
      };
    })();""")
    try:
        open_home(sender, base_url)
        open_home(receiver, base_url)
        name, payload = "completed-before-peer-exit.bin", b"already delivered, never reclassify as failed"
        code = join_without_approval(sender, receiver, name, payload)
        sender.locator("#approve-peer-button").click()
        receiver.locator("#receiver-file-list").get_by_text(name, exact=True).wait_for(timeout=10_000)
        download_result(sender, receiver, name, payload)
        return_home(receiver, "receiver-screen")
        sender.wait_for_function("() => globalThis.__completedChannelClosed === true", timeout=5_000)
        data = parse_diagnostic(copied_text(sender, diagnostic_button(sender, "sender")), [name, code])
        assert data["stage"] == "completed" and data["errorCode"] is None, data
        expect(sender.locator("#sender-title")).to_have_text("文件已送达")
        assert sender.locator("#sender-error").is_hidden()
        assert not errors, errors
        print("PASS completed peer departure: actual channel close cannot overwrite delivery with a failure", flush=True)
    finally:
        sender_context.close()
        receiver_context.close()


def verify_join_error_refresh(browser, base_url):
    errors = []
    context, page = configure_context(browser, errors, "receiver")
    try:
        open_home(page, base_url)
        page.locator("#choose-receiver").click()
        for attempt in range(6):
            code = str(100001 + attempt)
            page.get_by_label("6 位接收码").fill(code)
            page.locator("#join-room-button").click()
            expect(page.locator("#receiver-code-stage")).to_be_visible(timeout=5_000)
            expect(page.locator("#join-error")).to_be_visible()
            data = parse_diagnostic(copied_text(page, diagnostic_button(page, "receiver")), [code])
            expected_error = "ROOM_NOT_FOUND" if attempt < 5 else "RATE_LIMITED"
            assert data["errorCode"] == expected_error, f"Each new attempt needs its own actual error, got {data}"
            assert data["stage"] == "failed" and data["signalingState"] == "open"
        assert not errors, errors
        print("PASS repeated join errors: sixth real rate-limit response replaces the earlier room-not-found diagnosis", flush=True)
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:4138")
    parser.add_argument("--case", choices=["all", "lan-list", "lan-empty", "runtime-failed", "copy-fallback", "timeline", "diagnostic-unsafe", "diagnostic-timeout", "diagnostic-fallback", "retry-snapshot", "active-failure", "signal-failure", "relay-phases", "terminal-outlet", "completed-disconnect", "join-errors"], default="all")
    parser.add_argument("--start-server", action="store_true")
    args = parser.parse_args()
    cases = [
        ("lan-list", verify_lan_candidates, ()),
        ("lan-empty", verify_lan_unavailable, (False,)),
        ("runtime-failed", verify_lan_unavailable, (True,)),
        ("copy-fallback", verify_lan_copy_fallback, ()),
        ("timeline", verify_timeline_success, ()),
        ("diagnostic-unsafe", verify_failure_diagnostics, (False, True)),
        ("diagnostic-timeout", verify_failure_diagnostics, (True, True)),
        ("diagnostic-fallback", verify_failure_diagnostics, (False, False)),
        ("retry-snapshot", verify_retry_file_snapshot, ()),
        ("active-failure", verify_active_failure_snapshot, ()),
        ("signal-failure", verify_early_signal_failure, ()),
        ("relay-phases", verify_relay_diagnostic_phases, ()),
        ("terminal-outlet", verify_terminal_route_actions, ()),
        ("completed-disconnect", verify_completed_disconnect, ()),
        ("join-errors", verify_join_error_refresh, ()),
    ]
    with sync_playwright() as playwright:
        options = {"headless": True}
        browser_path = find_browser()
        if browser_path:
            options["executable_path"] = browser_path
        browser = playwright.chromium.launch(**options)
        try:
            for name, verify, parameters in cases:
                if args.case in {"all", name}:
                    with isolated_server(args.base_url, args.start_server, False):
                        verify(browser, args.base_url, *parameters)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
