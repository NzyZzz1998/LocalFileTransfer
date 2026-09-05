"""Real RTC recovery and OPFS write-preflight browser regressions.

Only native browser dependency boundaries are fault-injected. The actual UI,
room signaling, RTC negotiation/data channels, relay cipher, transfer engines,
storage selection and downloads remain production code. Large-file fixtures
override metadata only; they neither allocate nor transmit a giant payload.
"""

import argparse
import json
from pathlib import Path
import re

from playwright.sync_api import expect, sync_playwright

from e2e_relay_lifecycle_test import (
    approve_relay,
    file_payload,
    isolated_server,
    open_home,
    return_home,
)
from e2e_transfer_test import find_browser


TRACK_BOUNDARIES = """(() => {
  globalThis.__relaySockets = [];
  globalThis.__signalSockets = [];
  globalThis.__rtcSent = [];
  globalThis.__rtcPeers = [];
  const NativeWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      const path = new URL(String(args[0]), location.href).pathname;
      if (path === '/relay') {
        this.__relayRecord = { socket: this, sentStrings: [], sentFrames: 0 };
        globalThis.__relaySockets.push(this.__relayRecord);
      } else if (path === '/ws') globalThis.__signalSockets.push(this);
    }
    send(value) {
      if (this.__relayRecord) {
        if (typeof value === 'string') this.__relayRecord.sentStrings.push(value);
        else this.__relayRecord.sentFrames += 1;
      }
      return super.send(value);
    }
  };
  const nativeSend = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function(value) {
    globalThis.__rtcSent.push(typeof value === 'string' ? JSON.parse(value) : { binary: true });
    return nativeSend.call(this, value);
  };
  const NativePeer = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class extends NativePeer {
    constructor(...args) { super(...args); globalThis.__rtcPeers.push(this); }
  };
})();"""


def browser_fault_script(rtc_fault=None, storage_fault=None, large_metadata=False):
    # Faults at native boundaries catch a lost-room branch, optimistic OPFS
    # detection or a stale capability continuation, not a mock implementation.
    return """(() => {
      const config = CONFIG;
      if (config.rtc) {
        const prototype = RTCPeerConnection.prototype;
        const getStats = prototype.getStats;
        prototype.getStats = async function(...args) {
          const nativeStats = await getStats.apply(this, args);
          if (config.rtc === 'missing-stats') return new Map();
          if (config.rtc === 'throwing-stats') throw new Error('Injected native stats failure');
          if (config.rtc === 'delayed-stats') return new Promise(resolve => {
            globalThis.__releaseStats = () => resolve(nativeStats);
          });
          if (config.rtc === 'unsafe-pair') return new Map([...nativeStats].map(([key, value]) =>
            [key, ['local-candidate', 'remote-candidate'].includes(value.type)
              ? { ...value, candidateType: 'relay' } : value]));
          return nativeStats;
        };
        if (config.rtc === 'offer-rejected') prototype.createOffer = async function() {
          throw new Error('Injected native createOffer rejection');
        };
      }
      if (config.largeMetadata) {
        const size = Object.getOwnPropertyDescriptor(Blob.prototype, 'size').get;
        Object.defineProperty(File.prototype, 'size', {
          get() { return this.name === 'blocked-large.bin' ? 268435457 : size.call(this); }
        });
        const slice = Blob.prototype.slice;
        File.prototype.slice = function(...args) {
          if (this.name === 'blocked-large.bin') throw new Error('Blocked file content was read');
          return slice.apply(this, args);
        };
      }
      if (config.storage) {
        globalThis.__storageFault = { attempts: 0, writes: 0, releases: [], names: [] };
        const createWritable = FileSystemFileHandle.prototype.createWritable;
        FileSystemFileHandle.prototype.createWritable = async function(...args) {
          if (!this.name.startsWith('.dukou-')) return createWritable.apply(this, args);
          globalThis.__storageFault.attempts += 1;
          globalThis.__storageFault.names.push(this.name);
          if (config.storage === 'create-failed') throw new DOMException('Injected OPFS denial', 'NotAllowedError');
          if (config.storage === 'deferred') await new Promise(resolve => globalThis.__storageFault.releases.push(resolve));
          if (config.storage === 'deferred-sink-abort-reject' && !this.name.includes('-probe-')) {
            await new Promise(resolve => globalThis.__storageFault.releases.push(resolve));
          }
          return createWritable.apply(this, args);
        };
        if (config.storage === 'write-failed') {
          FileSystemWritableFileStream.prototype.write = async function() {
            globalThis.__storageFault.writes += 1;
            throw new DOMException('Injected OPFS write failure', 'QuotaExceededError');
          };
        }
        if (config.storage === 'drop-active') {
          const write = FileSystemWritableFileStream.prototype.write;
          FileSystemWritableFileStream.prototype.write = async function(value) {
            const result = await write.call(this, value);
            // The one-byte capability probe must remain untouched. Drop the
            // real connection only after a real transfer block reached disk.
            if (value.byteLength >= 16384 && !globalThis.__closedActivePeer) {
              globalThis.__closedActivePeer = true;
              globalThis.__rtcPeers.forEach(peer => peer.close());
            }
            return result;
          };
        }
        if (config.storage === 'deferred-sink-abort-reject') {
          const abort = FileSystemWritableFileStream.prototype.abort;
          FileSystemWritableFileStream.prototype.abort = async function(...args) {
            await abort.apply(this, args);
            globalThis.__storageFault.abortRejected = true;
            throw new DOMException('Injected abort rejection after native stream teardown', 'AbortError');
          };
        }
      }
    })();""".replace("CONFIG", json.dumps({
        "rtc": rtc_fault, "storage": storage_fault, "largeMetadata": large_metadata,
    }))


def make_context(browser, errors, label, **faults):
    context = browser.new_context(viewport={"width": 1280, "height": 960}, accept_downloads=True)
    context.add_init_script(TRACK_BOUNDARIES)
    context.add_init_script(browser_fault_script(**faults))
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(f"{label}: {error}"))
    return context, page


def begin_pair(sender, receiver, name, payload):
    sender.locator("#choose-sender").click()
    sender.locator("#send-file-input").set_input_files(file_payload(name, payload))
    sender.locator("#create-room-button").click()
    sender.locator("#room-code").filter(has_text=re.compile(r"\d{3}\s\d{3}")).wait_for(timeout=5_000)
    code = re.sub(r"\D", "", sender.locator("#room-code").inner_text())
    receiver.locator("#choose-receiver").click()
    receiver.get_by_label("6 位接收码").fill(code)
    receiver.locator("#join-room-button").click()
    sender.locator("#approve-peer-button").click()


def download_result(sender, receiver, name, payload):
    receiver.locator("#accept-files-button").click()
    receiver.get_by_role("heading", name="接收完成", exact=True).wait_for(timeout=15_000)
    sender.locator("#sender-progress-percent").get_by_text("100%", exact=True).wait_for(timeout=10_000)
    with receiver.expect_download(timeout=10_000) as download_info:
        receiver.get_by_role("button", name=f"保存 {name}", exact=True).click()
    assert Path(download_info.value.path()).read_bytes() == payload


def temporary_files(page):
    return page.evaluate("""async () => {
      const root = await navigator.storage.getDirectory();
      const names = [];
      for await (const name of root.keys()) if (name.startsWith('.dukou-')) names.push(name);
      return names;
    }""")


def verify_recovery(browser, base_url, fault):
    errors = []
    sender_context, sender = make_context(browser, errors, "sender", rtc_fault=fault)
    receiver_context, receiver = make_context(browser, errors, "receiver", rtc_fault=fault)
    try:
        open_home(sender, base_url)
        open_home(receiver, base_url)
        name = f"recover-{fault}.bin"
        payload = bytes((index * 17 + 31) % 256 for index in range(65_539))
        begin_pair(sender, receiver, name, payload)
        sender.locator("#sender-route-failed").wait_for(state="visible", timeout=5_000)
        assert sender.evaluate("globalThis.__signalSockets.at(-1).readyState") == 1, "Recoverable RTC failure must preserve signaling"
        assert sender.evaluate("globalThis.__rtcSent") == [], "Unverified RTC route must send no manifest/content"
        approve_relay(sender, receiver)
        receiver.locator("#receiver-file-list").get_by_text(name, exact=True).wait_for(timeout=10_000)
        download_result(sender, receiver, name, payload)
        for page, prefix in [(sender, "sender"), (receiver, "receiver")]:
            assert page.locator(f"#{prefix}-route-fact").inner_text() == "本地中转"
            assert page.locator(f"#{prefix}-encryption-fact").inner_text() == "应用层加密"
            assert page.evaluate("globalThis.__relaySockets[0].sentStrings") == []
            assert page.evaluate("globalThis.__relaySockets[0].sentFrames") > 1
            page.wait_for_function(
                "() => globalThis.__relaySockets.every(record => record.socket.readyState === WebSocket.CLOSED)",
                timeout=5_000,
            )
        assert not errors, errors
        print(f"PASS RTC {fault}: signaling retained, bilateral encrypted relay, byte-exact download", flush=True)
    finally:
        sender_context.close()
        receiver_context.close()


def verify_storage_failure(browser, base_url, fault, large):
    errors = []
    sender_context, sender = make_context(browser, errors, "sender", large_metadata=large)
    receiver_context, receiver = make_context(browser, errors, "receiver", storage_fault=fault)
    try:
        open_home(sender, base_url)
        open_home(receiver, base_url)
        name = "blocked-large.bin" if large else f"memory-{fault}.bin"
        payload = bytes((index * 29 + 11) % 256 for index in range(32_773))
        begin_pair(sender, receiver, name, payload)
        receiver.locator("#receiver-file-list").get_by_text(name, exact=True).wait_for(timeout=10_000)
        contract = receiver.locator(".storage-contract")
        expect(contract).to_contain_text("内存", timeout=5_000)
        assert temporary_files(receiver) == [], "Capability probe must remove its temporary file"
        if large:
            assert receiver.locator("#accept-files-button").is_disabled()
            expect(receiver.locator("#receiver-error")).to_contain_text("尚未接收任何文件内容")
            assert sender.evaluate("globalThis.__rtcSent.filter(message => message.binary || message.type === 'file_start')") == []
            assert receiver.locator("#receiver-progress").is_hidden()
            print(f"PASS OPFS {fault}: >256 MiB metadata blocked before file chunks; probe cleaned", flush=True)
        else:
            expect(receiver.locator("#accept-files-button")).to_be_enabled()
            download_result(sender, receiver, name, payload)
            assert temporary_files(receiver) == []
            assert receiver.locator("#receiver-route-fact").inner_text() == "局域网直连"
            print(f"PASS OPFS {fault}: explicit memory fallback, byte-exact small-file download, no orphan files", flush=True)
        assert not errors, errors
    finally:
        sender_context.close()
        receiver_context.close()


def verify_declined_relay_retry(browser, base_url):
    errors = []
    sender_context, sender = make_context(browser, errors, "sender", rtc_fault="missing-stats")
    receiver_context, receiver = make_context(browser, errors, "receiver", rtc_fault="missing-stats")
    try:
        open_home(sender, base_url)
        open_home(receiver, base_url)
        name = "decline-then-consent.bin"
        payload = bytes((index * 23 + 5) % 256 for index in range(32_781))
        begin_pair(sender, receiver, name, payload)
        sender.locator("#sender-route-failed").wait_for(state="visible", timeout=5_000)
        original_code = sender.locator("#room-code").inner_text()
        sender.locator("#use-relay-button").click()
        receiver.locator("#receiver-relay-consent").wait_for(state="visible", timeout=5_000)
        receiver.locator("#reject-relay-button").click()
        sender.locator("#sender-route-failed").wait_for(state="visible", timeout=5_000)
        assert receiver.locator("#receiver-screen").is_visible(), "Declining a route must not leave the approved room"
        assert receiver.evaluate("globalThis.__signalSockets.at(-1).readyState") == 1
        assert sender.evaluate("globalThis.__signalSockets.at(-1).readyState") == 1
        assert sender.locator("#room-code").inner_text() == original_code
        assert sender.evaluate("globalThis.__rtcSent") == []
        approve_relay(sender, receiver)
        receiver.locator("#receiver-file-list").get_by_text(name, exact=True).wait_for(timeout=10_000)
        download_result(sender, receiver, name, payload)
        assert receiver.locator("#receiver-route-fact").inner_text() == "本地中转"
        assert receiver.evaluate("globalThis.__relaySockets[0].sentStrings") == []
        assert not errors, errors
        print("PASS declined relay: room retained; second bilateral consent transfers exact bytes", flush=True)
    finally:
        sender_context.close()
        receiver_context.close()


def verify_probe_cancellation(browser, base_url):
    errors = []
    sender_context, sender = make_context(browser, errors, "sender")
    receiver_context, receiver = make_context(browser, errors, "receiver", storage_fault="deferred")
    try:
        open_home(sender, base_url)
        open_home(receiver, base_url)
        begin_pair(sender, receiver, "cancel-probe.bin", b"must not send while checking storage")
        receiver.locator("#receiver-file-list").get_by_text("cancel-probe.bin", exact=True).wait_for(timeout=10_000)
        receiver.wait_for_function("() => globalThis.__storageFault.releases.length > 0", timeout=5_000)
        assert receiver.locator("#accept-files-button").is_disabled()
        return_home(receiver, "receiver-screen")
        receiver.locator("#choose-receiver").click()
        receiver.evaluate("globalThis.__storageFault.releases.splice(0).forEach(resolve => resolve())")
        receiver.wait_for_function("""async () => {
          const root = await navigator.storage.getDirectory();
          for await (const name of root.keys()) if (name.startsWith('.dukou-')) return false;
          return true;
        }""", timeout=5_000)
        assert receiver.locator("#receiver-code-stage").is_visible()
        assert receiver.locator("#receiver-offer").is_hidden()
        assert receiver.locator("#accept-files-button").is_disabled()
        assert sender.evaluate("globalThis.__rtcSent.filter(message => message.binary || message.type === 'file_start')") == []
        assert not errors, errors
        print("PASS delayed OPFS probe: cancelling leaves new screen untouched and removes temporary file", flush=True)
    finally:
        sender_context.close()
        receiver_context.close()


def verify_active_drop(browser, base_url):
    errors = []
    sender_context, sender = make_context(browser, errors, "sender")
    receiver_context, receiver = make_context(browser, errors, "receiver", storage_fault="drop-active")
    try:
        open_home(sender, base_url)
        open_home(receiver, base_url)
        payload = bytes((index * 7 + 9) % 256 for index in range(262_147))
        begin_pair(sender, receiver, "active-drop.bin", payload)
        receiver.locator("#receiver-file-list").get_by_text("active-drop.bin", exact=True).wait_for(timeout=10_000)
        receiver.locator("#accept-files-button").click()
        receiver.wait_for_function("() => globalThis.__closedActivePeer === true", timeout=10_000)
        expect(sender.locator("#sender-error")).to_be_visible(timeout=10_000)
        assert sender.evaluate("globalThis.__rtcSent.some(message => message.binary)")
        assert sender.locator("#sender-route-failed").is_hidden(), "Active failure is terminal, not an invitation to switch transports"
        assert sender.locator("#use-relay-button").is_hidden()
        assert sender.evaluate("globalThis.__relaySockets.length") == 0
        assert receiver.evaluate("globalThis.__relaySockets.length") == 0
        receiver.wait_for_function("""async () => {
          const root = await navigator.storage.getDirectory();
          for await (const name of root.keys()) if (name.startsWith('.dukou-')) return false;
          return true;
        }""", timeout=5_000)
        assert not errors, errors
        print("PASS active RTC drop: written content causes terminal failure, no mid-transfer relay, partial storage cleaned", flush=True)
    finally:
        sender_context.close()
        receiver_context.close()


def verify_late_sink_abort_failure(browser, base_url):
    errors = []
    sender_context, sender = make_context(browser, errors, "sender")
    receiver_context, receiver = make_context(browser, errors, "receiver", storage_fault="deferred-sink-abort-reject")
    try:
        open_home(sender, base_url)
        open_home(receiver, base_url)
        name = "cancel-delayed-storage.bin"
        begin_pair(sender, receiver, name, b"no stale writable must survive cancellation")
        receiver.locator("#receiver-file-list").get_by_text(name, exact=True).wait_for(timeout=10_000)
        receiver.locator("#accept-files-button").click()
        receiver.wait_for_function("() => globalThis.__storageFault.releases.length > 0", timeout=5_000)
        return_home(receiver, "receiver-screen")
        receiver.locator("#choose-receiver").click()
        receiver.evaluate("globalThis.__storageFault.releases.splice(0).forEach(resolve => resolve())")
        receiver.wait_for_function("() => globalThis.__storageFault.abortRejected === true", timeout=5_000)
        receiver.wait_for_function("""async () => {
          const root = await navigator.storage.getDirectory();
          for await (const name of root.keys()) if (name.startsWith('.dukou-')) return false;
          return true;
        }""", timeout=5_000)
        assert receiver.locator("#receiver-code-stage").is_visible()
        assert receiver.locator("#receiver-error").is_hidden()
        assert receiver.locator("#receiver-complete").is_hidden()
        assert not errors, errors
        print("PASS late storage creation: cancellation keeps new screen intact; abort rejection still removes partial file", flush=True)
    finally:
        sender_context.close()
        receiver_context.close()


def verify_delayed_receiver_stats(browser, base_url):
    errors = []
    sender_context, sender = make_context(browser, errors, "sender")
    receiver_context, receiver = make_context(browser, errors, "receiver", rtc_fault="delayed-stats")
    try:
        open_home(sender, base_url)
        open_home(receiver, base_url)
        name = "delayed-receiver-verification.bin"
        payload = bytes((index * 13 + 3) % 256 for index in range(32_777))
        begin_pair(sender, receiver, name, payload)
        receiver.wait_for_function("() => typeof globalThis.__releaseStats === 'function'", timeout=5_000)
        sender.wait_for_function("() => globalThis.__rtcSent.some(message => message.type === 'offer_manifest')", timeout=5_000)
        assert receiver.locator("#accept-files-button").is_hidden() or receiver.locator("#accept-files-button").is_disabled()
        assert sender.evaluate("globalThis.__rtcSent.some(message => message.binary)") is False
        receiver.evaluate("globalThis.__releaseStats()")
        receiver.locator("#receiver-file-list").get_by_text(name, exact=True).wait_for(timeout=10_000)
        download_result(sender, receiver, name, payload)
        assert receiver.locator("#receiver-route-fact").inner_text() == "局域网直连"
        assert not errors, errors
        print("PASS delayed receiver stats: no premature accept, early manifest retained, byte-exact direct download", flush=True)
    finally:
        sender_context.close()
        receiver_context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:4133")
    parser.add_argument("--case", choices=["all", "missing-stats", "throwing-stats", "unsafe-pair", "offer-rejected", "storage-large", "storage-small", "probe-cancel", "active-drop", "delayed-stats", "relay-decline", "late-sink"], default="all")
    parser.add_argument("--start-server", action="store_true")
    args = parser.parse_args()
    cases = []
    for fault in ["missing-stats", "throwing-stats", "unsafe-pair", "offer-rejected"]:
        if args.case in {"all", fault}:
            cases.append((verify_recovery, (fault,)))
    for fault in ["create-failed", "write-failed"]:
        if args.case in {"all", "storage-large"}:
            cases.append((verify_storage_failure, (fault, True)))
        if args.case in {"all", "storage-small"}:
            cases.append((verify_storage_failure, (fault, False)))
    if args.case in {"all", "probe-cancel"}:
        cases.append((verify_probe_cancellation, ()))
    if args.case in {"all", "active-drop"}:
        cases.append((verify_active_drop, ()))
    if args.case in {"all", "delayed-stats"}:
        cases.append((verify_delayed_receiver_stats, ()))
    if args.case in {"all", "relay-decline"}:
        cases.append((verify_declined_relay_retry, ()))
    if args.case in {"all", "late-sink"}:
        cases.append((verify_late_sink_abort_failure, ()))
    if len(cases) > 5 and not args.start_server:
        parser.error("Use --start-server for all cases: each owns fresh rate-limit state without weakening production limits")
    with sync_playwright() as playwright:
        options = {"headless": True}
        browser_path = find_browser()
        if browser_path:
            options["executable_path"] = browser_path
        browser = playwright.chromium.launch(**options)
        try:
            for verify, parameters in cases:
                # Independent fixtures avoid accidentally testing the IP join
                # rate limiter after five distinct regression scenarios.
                with isolated_server(args.base_url, args.start_server, False):
                    verify(browser, args.base_url, *parameters)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
