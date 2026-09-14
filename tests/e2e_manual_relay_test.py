"""Manual pre-transfer relay through real RTC, signaling and encrypted WebSockets.

Catches requiring a direct-route failure before relay can be requested, skipping
either consent, sending file content before acceptance, or switching an active
transfer. Only an offer promise / second file read is held in the relevant case;
the native browser operation still runs and all downloaded bytes are real.
"""

import argparse
import socket

from playwright.sync_api import expect, sync_playwright

from e2e_recovery_preflight_test import begin_pair
from e2e_relay_lifecycle_test import isolated_server
from e2e_shutdown_test import (
    FILENAME,
    HOLD_SECOND_FILE_CHUNK,
    PAYLOAD,
    RESOURCE_SNAPSHOT,
    real_pages,
    request_shutdown,
    save_and_check,
)
from e2e_transfer_test import find_browser


TRACK_RELAY_AND_FILE_READS = r"""(() => {
  globalThis.__manualRelay = { sockets: [], fileBytesRead: 0 };
  const NativeSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      if (new URL(this.url).pathname === '/relay') {
        this.record = { socket: this, strings: [], binaryFrames: 0 };
        __manualRelay.sockets.push(this.record);
      }
    }
    send(value) {
      const result = super.send(value);
      if (this.record) {
        if (typeof value === 'string') this.record.strings.push(value);
        else this.record.binaryFrames += 1;
      }
      return result;
    }
  };
  const nativeSlice = File.prototype.slice;
  File.prototype.slice = function(...args) {
    const chunk = nativeSlice.apply(this, args);
    const nativeRead = chunk.arrayBuffer.bind(chunk);
    chunk.arrayBuffer = async () => {
      const buffer = await nativeRead();
      __manualRelay.fileBytesRead += buffer.byteLength;
      return buffer;
    };
    return chunk;
  };
})();"""


HOLD_NATIVE_OFFER = r"""(() => {
  const createOffer = RTCPeerConnection.prototype.createOffer;
  globalThis.__offerGate = { held: false };
  RTCPeerConnection.prototype.createOffer = async function(...args) {
    const offer = await createOffer.apply(this, args);
    __offerGate.held = true;
    await new Promise(resolve => { __offerGate.release = resolve; });
    return offer;
  };
})();"""


def assert_no_file_content(sender, receiver):
    assert sender.evaluate("__manualRelay.fileBytesRead") == 0, "Sender read file content before file acceptance"
    assert sender.evaluate("__shutdownProbe.sentBinaryBytes") == 0, "Direct channel sent file content before acceptance"
    assert receiver.evaluate("__shutdownProbe.sentBinaryBytes") == 0


def assert_no_relay_transport(sender, receiver):
    for page in (sender, receiver):
        assert page.evaluate("__manualRelay.sockets.length") == 0, "Relay transport opened before both route decisions"


def request_manual_relay(sender, receiver):
    # A healthy/connecting direct route must not require a failure panel first.
    expect(sender.locator("#use-relay-button")).to_be_visible(timeout=3_000)
    expect(sender.locator("#use-relay-button")).to_be_enabled()
    assert_no_file_content(sender, receiver)
    assert_no_relay_transport(sender, receiver)
    sender.locator("#use-relay-button").click()
    expect(receiver.locator("#receiver-relay-consent")).to_be_visible(timeout=5_000)
    expect(sender.locator("#use-relay-button")).to_be_hidden()
    assert_no_relay_transport(sender, receiver)
    assert_no_file_content(sender, receiver)
    # This is a user-selected route; claiming direct failed is misleading.
    assert "直连没有成功" not in receiver.locator("#receiver-relay-consent").inner_text()


def finish_relay(sender, receiver):
    receiver.locator("#approve-relay-button").click()
    expect(receiver.locator("#receiver-offer")).to_be_visible(timeout=10_000)
    expect(receiver.locator("#accept-files-button")).to_be_enabled(timeout=10_000)
    expect(sender.locator("#sender-connected small")).to_contain_text("文件尚未开始发送")
    expect(sender.locator("#sender-connected small")).not_to_contain_text("协商")
    expect(sender.locator("#sender-connected small")).not_to_contain_text("直连")
    assert_no_file_content(sender, receiver)
    for page in (sender, receiver):
        assert page.evaluate("__manualRelay.sockets.length") == 1
        page.wait_for_function("() => __shutdownProbe.peers.every(peer => peer.connectionState === 'closed')")
    expect(sender.locator("#use-relay-button")).to_be_hidden()
    receiver.locator("#accept-files-button").click()
    receiver.get_by_role("heading", name="接收完成", exact=True).wait_for(timeout=15_000)
    sender.locator("#sender-progress-percent").get_by_text("100%", exact=True).wait_for(timeout=10_000)
    save_and_check(receiver)
    for page, side in ((sender, "sender"), (receiver, "receiver")):
        assert page.locator(f"#{side}-route-fact").inner_text() == "本地中转"
        assert page.locator(f"#{side}-encryption-fact").inner_text() == "应用层加密"
        assert page.evaluate("__manualRelay.sockets[0].strings") == [], "Unencrypted string frame entered relay transport"
        assert page.evaluate("__manualRelay.sockets[0].binaryFrames") > 1
        page.wait_for_function("() => __manualRelay.sockets.every(record => record.socket.readyState === WebSocket.CLOSED)")
    assert sender.evaluate("__manualRelay.fileBytesRead") == len(PAYLOAD)


def verify_manual_relay(browser, base_url, connecting=False, decline=False):
    sender_script = TRACK_RELAY_AND_FILE_READS + (HOLD_NATIVE_OFFER if connecting else "")
    with real_pages(browser, base_url, sender_script, TRACK_RELAY_AND_FILE_READS) as (sender, receiver, control, errors):
        begin_pair(sender, receiver, FILENAME, PAYLOAD)
        if connecting:
            sender.wait_for_function("() => __offerGate.held === true")
            assert sender.evaluate(RESOURCE_SNAPSHOT)["rtc"] == ["new"]
            expect(receiver.locator("#receiver-offer")).to_be_hidden()
        else:
            expect(receiver.locator("#receiver-offer")).to_be_visible(timeout=10_000)
            expect(receiver.locator("#accept-files-button")).to_be_enabled(timeout=10_000)
            assert sender.evaluate(RESOURCE_SNAPSHOT)["rtc"] == ["connected"]
            expect(sender.locator("#sender-connected small")).to_contain_text("文件尚未开始发送")
        expect(sender.locator("#sender-route-failed")).to_be_hidden()
        code = sender.locator("#room-code").inner_text()
        request_manual_relay(sender, receiver)
        if decline:
            receiver.locator("#reject-relay-button").click()
            expect(sender.locator("#use-relay-button")).to_be_visible(timeout=5_000)
            for page in (sender, receiver):
                assert page.evaluate(RESOURCE_SNAPSHOT)["signaling"] == [1], "Declining the route must retain the paired room"
            assert sender.locator("#room-code").inner_text() == code
            assert_no_file_content(sender, receiver)
            request_manual_relay(sender, receiver)
        if connecting:
            sender.evaluate("__offerGate.release()")
            sender.evaluate("() => new Promise(resolve => requestAnimationFrame(resolve))")
            expect(receiver.locator("#receiver-relay-consent")).to_be_visible()
            assert_no_relay_transport(sender, receiver)
        finish_relay(sender, receiver)
        response = request_shutdown(control)
        assert response.status == 200, response.text()
        assert not errors, errors
        label = "connecting" if connecting else "direct ready"
        print(f"PASS manual relay ({label}{', decline/retry' if decline else ''}): bilateral consent, no premature file bytes, encrypted byte-exact download", flush=True)


def verify_no_mid_transfer_entry(browser, base_url):
    with real_pages(browser, base_url, TRACK_RELAY_AND_FILE_READS + HOLD_SECOND_FILE_CHUNK, TRACK_RELAY_AND_FILE_READS) as (sender, receiver, control, errors):
        begin_pair(sender, receiver, FILENAME, PAYLOAD)
        expect(sender.locator("#use-relay-button")).to_be_visible(timeout=10_000)
        expect(receiver.locator("#receiver-offer")).to_be_visible(timeout=10_000)
        expect(receiver.locator("#accept-files-button")).to_be_enabled(timeout=10_000)
        receiver.locator("#accept-files-button").click()
        sender.wait_for_function("() => __fileReadGate.blocked === true")
        assert sender.evaluate("__shutdownProbe.sentBinaryBytes") > 0
        expect(sender.locator("#use-relay-button")).to_be_hidden()
        # Bypassing the hidden UI must not bypass the active-transfer guard.
        sender.locator("#use-relay-button").dispatch_event("click")
        sender.evaluate("() => new Promise(resolve => requestAnimationFrame(resolve))")
        assert_no_relay_transport(sender, receiver)
        expect(receiver.locator("#receiver-relay-consent")).to_be_hidden()
        sender.evaluate("__fileReadGate.release()")
        receiver.get_by_role("heading", name="接收完成", exact=True).wait_for(timeout=15_000)
        save_and_check(receiver)
        assert receiver.locator("#receiver-route-fact").inner_text() == "局域网直连"
        response = request_shutdown(control)
        assert response.status == 200, response.text()
        assert not errors, errors
        print("PASS active transfer: relay entry hidden, synthetic click cannot switch route, original direct download remains exact", flush=True)


def verify_disabled_entry(browser, base_url):
    with real_pages(browser, base_url, TRACK_RELAY_AND_FILE_READS, TRACK_RELAY_AND_FILE_READS) as (sender, receiver, control, errors):
        assert sender.evaluate("async () => (await fetch('/api/runtime')).json()")["relayEnabled"] is False
        begin_pair(sender, receiver, FILENAME, PAYLOAD)
        expect(receiver.locator("#receiver-offer")).to_be_visible(timeout=10_000)
        expect(receiver.locator("#accept-files-button")).to_be_enabled(timeout=10_000)
        button = sender.locator("#use-relay-button")
        assert button.is_hidden() or button.is_disabled(), "Disabled server exposed a working manual relay entry"
        button.dispatch_event("click")
        assert_no_relay_transport(sender, receiver)
        assert_no_file_content(sender, receiver)
        receiver.locator("#accept-files-button").click()
        receiver.get_by_role("heading", name="接收完成", exact=True).wait_for(timeout=15_000)
        save_and_check(receiver)
        assert receiver.locator("#receiver-route-fact").inner_text() == "局域网直连"
        assert_no_relay_transport(sender, receiver)
        response = request_shutdown(control)
        assert response.status == 200, response.text()
        assert not errors, errors
        print("PASS relay disabled: no manual relay entry or transport, direct transfer remains byte exact", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    cases = ["ready", "connecting", "decline", "active", "disabled"]
    parser.add_argument("--case", choices=["all", *cases], default="all")
    args = parser.parse_args()
    with sync_playwright() as playwright:
        options = {"headless": True}
        path = find_browser()
        if path:
            options["executable_path"] = path
        browser = playwright.chromium.launch(**options)
        try:
            for case in cases if args.case == "all" else [args.case]:
                with socket.socket() as reservation:
                    reservation.bind(("127.0.0.1", 0))
                    port = reservation.getsockname()[1]
                assert port != 3000
                base_url = f"http://127.0.0.1:{port}"
                with isolated_server(base_url, True, case == "disabled"):
                    if case in {"ready", "connecting", "decline"}:
                        verify_manual_relay(browser, base_url, connecting=case == "connecting", decline=case == "decline")
                    elif case == "active":
                        verify_no_mid_transfer_entry(browser, base_url)
                    else:
                        verify_disabled_entry(browser, base_url)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
