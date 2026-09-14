"""Real-browser shutdown regression, each case owning its disposable server.

Catches service shutdown that leaves native RTC peers, browser storage or timers
alive, and shutdown that destroys a remote browser's unsaved completed files.
Never connects to or terminates a pre-existing service (including user port 3000).
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
from urllib.request import urlopen

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright

from e2e_transfer_test import find_browser


ROOT = Path(__file__).resolve().parents[1]
PAYLOAD = bytes((index * 31 + 7) % 256 for index in range(196_613))
FILENAME = "shutdown-byte-proof.bin"

# These wrappers retain actual browser resources and forward every operation.
# A closed fake RTC object or intercepted shutdown response cannot satisfy this
# suite: ICE, data transfer, storage, HTTP and process exit are all real.
TRACK_RESOURCES = r"""(() => {
  const probe = globalThis.__shutdownProbe = {
    peers: [], sockets: [], channels: [], timeouts: new Map(), intervals: new Map(),
    objectUrls: new Set(), sentBinaryBytes: 0, writtenBytes: 0,
  };
  const NativePeer = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class extends NativePeer {
    constructor(...args) {
      super(...args);
      probe.peers.push(this);
      this.addEventListener('datachannel', event => probe.channels.push(event.channel));
    }
    createDataChannel(...args) {
      const channel = super.createDataChannel(...args);
      probe.channels.push(channel);
      return channel;
    }
  };
  const NativeSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends NativeSocket {
    constructor(...args) { super(...args); probe.sockets.push(this); }
  };
  const nativeSend = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function(value) {
    const result = nativeSend.call(this, value);
    if (typeof value !== 'string') probe.sentBinaryBytes += value.byteLength || value.size || 0;
    return result;
  };
  if (globalThis.FileSystemWritableFileStream) {
    const nativeWrite = FileSystemWritableFileStream.prototype.write;
    FileSystemWritableFileStream.prototype.write = async function(value) {
      const result = await nativeWrite.call(this, value);
      probe.writtenBytes += value.byteLength || value.size || 0;
      return result;
    };
  }
  const belongsToApp = () => /\/(?:app|peer-session|transfer|storage|relay-transport|relay-crypto)\.js(?::|\?)/.test(new Error().stack || '');
  const nativeTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeInterval = globalThis.setInterval.bind(globalThis);
  const clearNativeTimeout = globalThis.clearTimeout.bind(globalThis);
  const clearNativeInterval = globalThis.clearInterval.bind(globalThis);
  globalThis.setTimeout = (callback, delay, ...args) => {
    let id;
    const invoke = typeof callback === 'function' ? (...values) => {
      probe.timeouts.delete(id);
      callback(...values);
    } : callback;
    id = nativeTimeout(invoke, delay, ...args);
    if (belongsToApp()) probe.timeouts.set(id, Number(delay) || 0);
    return id;
  };
  globalThis.setInterval = (callback, delay, ...args) => {
    const id = nativeInterval(callback, delay, ...args);
    if (belongsToApp()) probe.intervals.set(id, Number(delay) || 0);
    return id;
  };
  globalThis.clearTimeout = id => {
    probe.timeouts.delete(id);
    probe.intervals.delete(id);
    clearNativeTimeout(id);
  };
  globalThis.clearInterval = id => {
    probe.timeouts.delete(id);
    probe.intervals.delete(id);
    clearNativeInterval(id);
  };
  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = value => {
    const url = createObjectURL(value);
    probe.objectUrls.add(url);
    return url;
  };
  URL.revokeObjectURL = url => {
    probe.objectUrls.delete(url);
    return revokeObjectURL(url);
  };
})();"""

# Pause one native file read only after the first real chunk can reach OPFS.
# Releasing it after shutdown checks that stale transfer continuations cannot
# transmit again. The app and its transfer engine are never substituted.
HOLD_SECOND_FILE_CHUNK = """(() => {
  const nativeSlice = File.prototype.slice;
  globalThis.__fileReadGate = { blocked: false, released: false };
  File.prototype.slice = function(...args) {
    const chunk = nativeSlice.apply(this, args);
    if (this.name === 'shutdown-byte-proof.bin' && Number(args[0]) > 0 && !__fileReadGate.blocked) {
      const read = chunk.arrayBuffer.bind(chunk);
      chunk.arrayBuffer = () => new Promise((resolve, reject) => {
        __fileReadGate.blocked = true;
        __fileReadGate.release = () => {
          __fileReadGate.released = true;
          read().then(resolve, reject);
        };
      });
    }
    return chunk;
  };
})();"""

FAIL_TEMPORARY_REMOVAL = """(() => {
  globalThis.__removalFault = { enabled: false, failures: 0 };
  const removeEntry = FileSystemDirectoryHandle.prototype.removeEntry;
  FileSystemDirectoryHandle.prototype.removeEntry = function(name, ...args) {
    if (__removalFault.enabled && name.startsWith('.dukou-') && name.endsWith('.part')) {
      __removalFault.failures += 1;
      return Promise.reject(new DOMException('Injected persistent OPFS remove denial', 'NoModificationAllowedError'));
    }
    return removeEntry.call(this, name, ...args);
  };
})();"""

HOLD_FIRST_STORAGE_PROBE = """(() => {
  globalThis.__probeGate = { held: false };
  const createWritable = FileSystemFileHandle.prototype.createWritable;
  FileSystemFileHandle.prototype.createWritable = async function(...args) {
    const writable = await createWritable.apply(this, args);
    if (this.name.startsWith('.dukou-probe-') && !__probeGate.held) {
      __probeGate.held = true;
      await new Promise(resolve => { __probeGate.release = resolve; });
    }
    return writable;
  };
})();"""

HOLD_RECEIVER_SHUTDOWN_MESSAGE = """(() => {
  globalThis.__shutdownMessageGate = { held: false, released: false };
  const NativeSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => {
        if (__shutdownMessageGate.released || typeof event.data !== 'string') return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type !== 'service_shutdown') return;
        event.stopImmediatePropagation();
        __shutdownMessageGate.held = true;
        const data = event.data;
        __shutdownMessageGate.release = () => {
          __shutdownMessageGate.released = true;
          // Deliver the exact bytes received from the native server socket.
          this.dispatchEvent(new MessageEvent('message', { data }));
        };
      }, true);
    }
  };
})();"""

TEMPORARY_FILES = """async () => {
  const root = await navigator.storage.getDirectory();
  const names = [];
  for await (const name of root.keys()) {
    if (name.startsWith('.dukou-') && name.endsWith('.part')) names.push(name);
  }
  return names.sort();
}"""

RESOURCE_SNAPSHOT = """() => ({
  rtc: __shutdownProbe.peers.map(peer => peer.connectionState),
  sockets: __shutdownProbe.sockets.map(socket => socket.readyState),
  signaling: __shutdownProbe.sockets.filter(socket => new URL(socket.url).pathname === '/ws').map(socket => socket.readyState),
  channels: __shutdownProbe.channels.map(channel => channel.readyState),
  timeouts: [...__shutdownProbe.timeouts.values()],
  intervals: [...__shutdownProbe.intervals.values()],
  objectUrls: __shutdownProbe.objectUrls.size,
})"""


class OwnedServer:
    def __init__(self, binary: Path | None = None):
        # Reserve/recheck an OS-selected port before launching the only process
        # this test is allowed to stop. No caller-supplied URL can target a user
        # service, and the success assertion never terminates the process.
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = reservation.getsockname()[1]
        assert self.port != 3000
        self.base_url = f"http://127.0.0.1:{self.port}"
        executable = str(binary.resolve()) if binary else shutil.which("bun")
        assert executable, "Bun is required to launch the isolated source server"
        if binary:
            assert binary.is_file(), f"Binary does not exist: {binary}"
        self.command = [executable] if binary else [executable, "src/server.ts"]
        self.process = None
        self.logs = None

    def __enter__(self):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", self.port))
        self.logs = tempfile.TemporaryFile()
        self.process = subprocess.Popen(
            self.command,
            cwd=ROOT,
            env={**os.environ, "HOST": "127.0.0.1", "PORT": str(self.port)},
            stdin=subprocess.DEVNULL,
            stdout=self.logs,
            stderr=self.logs,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        print(f"Owned shutdown server PID {self.process.pid}, port {self.port}", flush=True)
        try:
            deadline = time.monotonic() + 15
            while True:
                assert self.process.poll() is None, self.log_text()
                try:
                    with urlopen(f"{self.base_url}/healthz", timeout=0.5) as response:
                        if response.status == 200:
                            return self
                except OSError:
                    pass
                assert time.monotonic() < deadline, f"Server did not become ready: {self.log_text()}"
                time.sleep(0.05)
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def log_text(self):
        self.logs.seek(0)
        return self.logs.read().decode(errors="replace")

    def assert_alive(self):
        assert self.process.poll() is None, f"Owned server unexpectedly exited: {self.log_text()}"
        with urlopen(f"{self.base_url}/healthz", timeout=2) as response:
            assert response.status == 200

    def assert_stopped(self):
        try:
            code = self.process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            raise AssertionError(f"Owned server PID {self.process.pid} did not exit by itself") from None
        assert code == 0, f"Owned server exited with {code}: {self.log_text()}"
        with socket.socket() as probe:
            probe.settimeout(1)
            assert probe.connect_ex(("127.0.0.1", self.port)) != 0, "Shutdown port is still listening"

    def __exit__(self, exc_type, exc_value, traceback):
        if self.process and self.process.poll() is None:
            # Failure cleanup is scoped to the process object created above.
            # Every successful case must call assert_stopped before this point.
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if self.logs:
            self.logs.close()


@contextmanager
def real_pages(browser, base_url, sender_script=None, receiver_script=None):
    contexts = []
    pages = []
    errors = []
    try:
        for side in ("sender", "receiver", "control"):
            context = browser.new_context(viewport={"width": 1280, "height": 960}, accept_downloads=True)
            contexts.append(context)
            context.add_init_script(TRACK_RESOURCES)
            if side == "sender" and sender_script:
                context.add_init_script(sender_script)
            if side == "receiver" and receiver_script:
                context.add_init_script(receiver_script)
            page = context.new_page()
            page.on("pageerror", lambda error, label=side: errors.append(f"{label}: {error}"))
            page.goto(base_url)
            page.wait_for_load_state("networkidle")
            page.locator("#home-screen").wait_for(state="visible")
            pages.append(page)
        yield (*pages, errors)
    finally:
        for context in reversed(contexts):
            context.close()


def connect_and_receive(sender, receiver, payload=PAYLOAD, complete=True, files=None, accept=True):
    sender.locator("#choose-sender").click()
    files = files or [{
        "name": FILENAME, "mimeType": "application/octet-stream", "buffer": payload,
    }]
    sender.locator("#send-file-input").set_input_files(files)
    sender.locator("#create-room-button").click()
    sender.locator("#room-code").filter(has_text=re.compile(r"\d{3}\s\d{3}")).wait_for(timeout=5_000)
    code = re.sub(r"\D", "", sender.locator("#room-code").inner_text())
    assert len(code) == 6
    receiver.locator("#choose-receiver").click()
    receiver.get_by_label("6 位接收码").fill(code)
    receiver.locator("#join-room-button").click()
    sender.locator("#approve-peer-button").wait_for(state="visible", timeout=5_000)
    sender.locator("#approve-peer-button").click()
    receiver.locator("#receiver-file-list").get_by_text(files[0]["name"], exact=True).wait_for(timeout=10_000)
    if accept:
        receiver.locator("#accept-files-button").click()
    if complete:
        receiver.get_by_role("heading", name="接收完成", exact=True).wait_for(timeout=15_000)
        sender.locator("#sender-progress-percent").get_by_text("100%", exact=True).wait_for(timeout=10_000)
    for page, prefix in ((sender, "sender"), (receiver, "receiver")):
        assert page.locator(f"#{prefix}-route-fact").inner_text() == "局域网直连"
        snapshot = page.evaluate(RESOURCE_SNAPSHOT)
        assert snapshot["rtc"] == ["connected"], snapshot
        # Local pages additionally own a page-lifetime management connection.
        assert snapshot["signaling"] == [1], snapshot


def save_and_check(receiver, payload=PAYLOAD, name=FILENAME):
    with receiver.expect_download(timeout=10_000) as download:
        receiver.get_by_role("button", name=f"保存 {name}", exact=True).click()
    assert Path(download.value.path()).read_bytes() == payload, "Downloaded bytes changed"


def request_shutdown(control, accept=True, while_pending=None):
    dialogs = []

    def answer(dialog):
        dialogs.append(dialog.message)
        assert dialog.type == "confirm"
        dialog.accept() if accept else dialog.dismiss()

    control.once("dialog", answer)
    if accept:
        with control.expect_response(lambda response: response.url.endswith("/api/shutdown"), timeout=12_000) as response:
            control.locator("#shutdown-service-button").click()
            if while_pending:
                while_pending()
        assert len(dialogs) == 1, "Shutdown must request native confirmation"
        return response.value
    control.locator("#shutdown-service-button").click()
    assert len(dialogs) == 1, "Shutdown must request native confirmation"
    return None


def assert_browser_clean(page, label):
    try:
        page.wait_for_function("() => __shutdownProbe.peers.every(peer => peer.connectionState === 'closed')", timeout=5_000)
    except PlaywrightTimeoutError:
        pass
    snapshot = page.evaluate(RESOURCE_SNAPSHOT)
    assert snapshot["rtc"] and all(state == "closed" for state in snapshot["rtc"]), (
        f"{label}: native RTCPeerConnection stayed alive after service shutdown: {snapshot}"
    )
    # RTC close is synchronous; the WebSocket close handshake is asynchronous.
    page.wait_for_function("() => __shutdownProbe.sockets.every(socket => socket.readyState === 3)", timeout=5_000)
    snapshot = page.evaluate(RESOURCE_SNAPSHOT)
    assert all(state == 3 for state in snapshot["sockets"]), f"{label}: open WebSocket: {snapshot}"
    assert all(state == "closed" for state in snapshot["channels"]), f"{label}: open RTCDataChannel: {snapshot}"
    assert page.evaluate(TEMPORARY_FILES) == [], f"{label}: OPFS partial files remain"
    assert snapshot["intervals"] == [], f"{label}: live app intervals: {snapshot}"
    assert snapshot["timeouts"] == [], f"{label}: live app timeouts: {snapshot}"
    assert snapshot["objectUrls"] == 0, f"{label}: retained download object URL: {snapshot}"


def verify_completed_saved(browser, binary=None):
    # Missing client shutdown handling must fail on real, already connected RTC
    # peers even when closing the server successfully closes signaling sockets.
    with OwnedServer(binary) as server, real_pages(browser, server.base_url) as (sender, receiver, control, errors):
        connect_and_receive(sender, receiver)
        assert len(receiver.evaluate(TEMPORARY_FILES)) == 1
        save_and_check(receiver)
        response = request_shutdown(control)
        assert response.status == 200, response.text()
        control.locator("#shutdown-notice").wait_for(state="visible")
        assert_browser_clean(sender, "sender")
        assert_browser_clean(receiver, "receiver")
        server.assert_stopped()
        assert not errors, errors
        print("PASS completed saved shutdown: byte-exact download, RTC/WS/timers/OPFS cleaned, owned PID exited 0 and port closed", flush=True)


def verify_completed_unsaved(browser, binary=None, discard=False):
    # A remote browser must retain its only completed copy when the host asks
    # to stop. Saving or explicitly discarding that copy then allows retry.
    with OwnedServer(binary) as server, real_pages(browser, server.base_url) as (sender, receiver, control, errors):
        connect_and_receive(sender, receiver)
        original_files = receiver.evaluate(TEMPORARY_FILES)
        assert len(original_files) == 1
        response = request_shutdown(control)
        assert response.status == 409, f"Unsaved remote file must block shutdown, got HTTP {response.status}"
        assert response.json().get("code") == "SHUTDOWN_UNSAVED_FILES", response.text()
        server.assert_alive()
        assert receiver.evaluate(RESOURCE_SNAPSHOT)["intervals"], "Blocked shutdown must keep signaling heartbeat alive until the user saves or discards"
        status = control.locator("#shutdown-status")
        status.wait_for(state="visible")
        assert "未保存" in status.inner_text(), "Host did not explain which user action blocks shutdown"
        assert control.locator("#shutdown-notice").is_hidden()
        assert control.locator("#shutdown-service-button").is_enabled()
        receiver.get_by_role("heading", name="接收完成", exact=True).wait_for()
        assert receiver.evaluate(TEMPORARY_FILES) == original_files, "Blocked shutdown removed the only received copy"
        assert receiver.get_by_role("button", name=f"保存 {FILENAME}", exact=True).is_enabled()
        if discard:
            # Read the real OPFS file without handing it to the browser download
            # manager; this must not mark the application entry as saved.
            contents = receiver.evaluate("""async name => {
              const root = await navigator.storage.getDirectory();
              const file = await (await root.getFileHandle(name)).getFile();
              return Array.from(new Uint8Array(await file.arrayBuffer()));
            }""", original_files[0])
            assert bytes(contents) == PAYLOAD
            confirmations = []

            def discard_result(dialog):
                confirmations.append(dialog.message)
                assert dialog.type == "confirm"
                dialog.accept()

            receiver.once("dialog", discard_result)
            receiver.locator("#receiver-screen [data-action='back-home']").first.click()
            receiver.locator("#home-screen").wait_for(state="visible")
            assert len(confirmations) == 1 and "保存" in confirmations[0]
            assert receiver.evaluate(TEMPORARY_FILES) == [], "Explicit discard did not remove OPFS results"
        else:
            save_and_check(receiver)
        response = request_shutdown(control)
        assert response.status == 200, response.text()
        control.locator("#shutdown-notice").wait_for(state="visible")
        assert_browser_clean(sender, "sender")
        assert_browser_clean(receiver, "receiver")
        server.assert_stopped()
        assert not errors, errors
        action = "explicit discard" if discard else "byte-exact save"
        print(f"PASS completed unsaved shutdown: HTTP 409 and visible feedback, copy retained, {action} permits clean retry", flush=True)


def verify_cancelled_confirmation(browser, binary=None):
    # Moving HTTP shutdown before native confirmation, or cleaning resources
    # before checking its answer, destroys this completed but unsaved transfer.
    with OwnedServer(binary) as server, real_pages(browser, server.base_url) as (sender, receiver, control, errors):
        connect_and_receive(sender, receiver)
        original_files = receiver.evaluate(TEMPORARY_FILES)
        requests = []
        control.on("request", lambda request: requests.append(request.url) if request.url.endswith("/api/shutdown") else None)
        request_shutdown(control, accept=False)
        # This same-origin response is an event-loop barrier after the click's
        # async handler; cancellation must not issue any shutdown request.
        assert control.evaluate("async () => (await fetch('/healthz')).ok") is True
        assert requests == [], "Cancelling native confirmation still sent a shutdown request"
        server.assert_alive()
        for page in (sender, receiver):
            snapshot = page.evaluate(RESOURCE_SNAPSHOT)
            assert snapshot["rtc"] == ["connected"], snapshot
            assert snapshot["channels"] == ["open"], snapshot
            assert snapshot["signaling"] == [1], snapshot
        assert receiver.evaluate(TEMPORARY_FILES) == original_files
        assert control.locator("#shutdown-notice").is_hidden()
        assert control.locator("#shutdown-service-button").is_enabled()
        save_and_check(receiver)
        response = request_shutdown(control)
        assert response.status == 200, response.text()
        assert_browser_clean(sender, "sender")
        assert_browser_clean(receiver, "receiver")
        server.assert_stopped()
        assert not errors, errors
        print("PASS cancelled confirmation: no shutdown request, service/RTC/WS/file preserved, later save and close succeeds", flush=True)


def verify_active_transfer(browser, binary=None):
    # Closing only signaling or forgetting engine cancellation leaves a real
    # partial OPFS file, or resumes sending when the pending disk read returns.
    with OwnedServer(binary) as server, real_pages(browser, server.base_url, HOLD_SECOND_FILE_CHUNK) as (sender, receiver, control, errors):
        connect_and_receive(sender, receiver, complete=False)
        sender.wait_for_function("() => __fileReadGate.blocked", timeout=5_000)
        receiver.wait_for_function("() => __shutdownProbe.writtenBytes >= 16384", timeout=5_000)
        assert receiver.locator("#receiver-progress").is_visible()
        assert receiver.locator("#receiver-complete").is_hidden()
        assert len(receiver.evaluate(TEMPORARY_FILES)) == 1
        sent_before = sender.evaluate("() => __shutdownProbe.sentBinaryBytes")
        assert 0 < sent_before < len(PAYLOAD)
        def release_cancelled_read():
            # Closing RTC first stops network activity; acknowledge shutdown
            # only after the in-flight native read settles and cannot resume.
            sender.wait_for_function("() => __shutdownProbe.peers.every(peer => peer.connectionState === 'closed')", timeout=5_000)
            sender.evaluate("() => __fileReadGate.release()")

        response = request_shutdown(control, while_pending=release_cancelled_read)
        assert response.status == 200, response.text()
        assert_browser_clean(sender, "sender")
        assert_browser_clean(receiver, "receiver")
        server.assert_stopped()
        sender.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        assert sender.evaluate("() => __shutdownProbe.sentBinaryBytes") == sent_before, "A stale file read resumed sending after shutdown"
        assert_browser_clean(sender, "sender after late read")
        assert_browser_clean(receiver, "receiver after late read")
        assert receiver.get_by_role("button", name=f"保存 {FILENAME}", exact=True).count() == 0
        assert not errors, errors
        print("PASS active shutdown: real partial write removed, engines/RTC/WS/timers closed, late native read cannot resume", flush=True)


def verify_partial_batch(browser, binary=None):
    # Checking only overall transfer completion erases an already finalized
    # first file when shutdown interrupts the second file in the same batch.
    first_name = "already-received.bin"
    first_payload = b"Received before the interrupted second file\n" * 257
    files = [
        {"name": first_name, "mimeType": "application/octet-stream", "buffer": first_payload},
        {"name": FILENAME, "mimeType": "application/octet-stream", "buffer": PAYLOAD},
    ]
    with OwnedServer(binary) as server, real_pages(browser, server.base_url, HOLD_SECOND_FILE_CHUNK, HOLD_RECEIVER_SHUTDOWN_MESSAGE) as (sender, receiver, control, errors):
        connect_and_receive(sender, receiver, complete=False, files=files)
        sender.wait_for_function("() => __fileReadGate.blocked", timeout=5_000)
        receiver.wait_for_function("minimum => __shutdownProbe.writtenBytes >= minimum", arg=len(first_payload) + 16384, timeout=5_000)
        assert len(receiver.evaluate(TEMPORARY_FILES)) == 2
        sent_before = sender.evaluate("() => __shutdownProbe.sentBinaryBytes")

        def release_cancelled_read():
            sender.wait_for_function("() => __shutdownProbe.peers.every(peer => peer.connectionState === 'closed')", timeout=5_000)
            sender.evaluate("() => __fileReadGate.release()")
            receiver.wait_for_function("() => __shutdownMessageGate.held", timeout=5_000)
            receiver.wait_for_function("() => __shutdownProbe.peers.every(peer => peer.connectionState === 'closed')", timeout=5_000)
            # The sender's shutdown reaches RTC first. The already completed
            # file must survive that disconnect before this receiver is told
            # about shutdown through its delayed signaling message.
            try:
                receiver.get_by_role("button", name=f"保存 {first_name}", exact=True).wait_for(state="visible", timeout=3_000)
            except PlaywrightTimeoutError:
                raise AssertionError(
                    "Finalized first file was not offered for saving after RTC closed before shutdown notice: "
                    f"resources={receiver.evaluate(RESOURCE_SNAPSHOT)}, files={receiver.evaluate(TEMPORARY_FILES)}, "
                    f"receiver_error={receiver.locator('#receiver-error').inner_text()}, "
                    f"received_list={receiver.locator('#received-files').inner_text()}"
                ) from None
            retained_bytes = receiver.evaluate("""async size => {
              const root = await navigator.storage.getDirectory();
              for await (const [name, handle] of root.entries()) {
                if (!name.startsWith('.dukou-') || handle.kind !== 'file') continue;
                const file = await handle.getFile();
                if (file.size === size) return Array.from(new Uint8Array(await file.arrayBuffer()));
              }
              return null;
            }""", len(first_payload))
            assert retained_bytes is not None and bytes(retained_bytes) == first_payload, "RTC closed before shutdown notice and destroyed the finalized first file"
            assert receiver.evaluate("() => __shutdownMessageGate.released") is False
            receiver.evaluate("() => __shutdownMessageGate.release()")

        response = request_shutdown(control, while_pending=release_cancelled_read)
        assert response.status == 409, f"Completed first file in partial batch must block shutdown, got HTTP {response.status}"
        assert response.json().get("code") == "SHUTDOWN_UNSAVED_FILES", response.text()
        server.assert_alive()
        control.locator("#shutdown-status").wait_for(state="visible")
        assert "未保存" in control.locator("#shutdown-status").inner_text()
        first_save = receiver.get_by_role("button", name=f"保存 {first_name}", exact=True)
        first_save.wait_for(state="visible", timeout=5_000)
        assert first_save.is_enabled(), "Completed first file is no longer available to save"
        assert receiver.get_by_role("button", name=f"保存 {FILENAME}", exact=True).count() == 0
        save_and_check(receiver, first_payload, first_name)
        assert sender.evaluate("() => __shutdownProbe.sentBinaryBytes") == sent_before, "Interrupted batch resumed sending"
        response = request_shutdown(control)
        assert response.status == 200, response.text()
        assert_browser_clean(sender, "partial batch sender")
        assert_browser_clean(receiver, "partial batch receiver")
        server.assert_stopped()
        assert not errors, errors
        print("PASS partial batch: first finalized file survives RTC closing before shutdown notice, blocks shutdown and remains byte-exact downloadable; saved retry cleans second partial file", flush=True)


def verify_cleanup_failure(browser, binary=None, return_home=False):
    # Swallowing a native removal failure, or dropping the signaling owner on
    # normal home navigation, would let shutdown report success with OPFS data
    # still present. Retry must use the same retained browser and live service.
    with OwnedServer(binary) as server, real_pages(browser, server.base_url, receiver_script=FAIL_TEMPORARY_REMOVAL) as (sender, receiver, control, errors):
        connect_and_receive(sender, receiver)
        save_and_check(receiver)
        receiver.evaluate("() => { __removalFault.enabled = true; }")
        if return_home:
            receiver.locator("#receiver-screen [data-action='back-home']").first.click()
            receiver.wait_for_function("() => __removalFault.failures > 0", timeout=8_000)
        response = request_shutdown(control)
        assert response.status == 409, f"Persistent OPFS removal failure must block shutdown, got HTTP {response.status}"
        assert response.json().get("code") == "SHUTDOWN_CLEANUP_FAILED", response.text()
        server.assert_alive()
        assert receiver.evaluate("() => __removalFault.failures") > 0
        assert len(receiver.evaluate(TEMPORARY_FILES)) == 1, "Test must still contain the file whose removal failed"
        snapshot = receiver.evaluate(RESOURCE_SNAPSHOT)
        assert snapshot["signaling"] == [1], f"Cleanup failure lost the signaling owner required for retry: {snapshot}"
        for page in (receiver, control):
            page.locator("#shutdown-status").wait_for(state="visible")
            assert "清理" in page.locator("#shutdown-status").inner_text()
        assert control.locator("#shutdown-notice").is_hidden()
        receiver.evaluate("() => { __removalFault.enabled = false; }")
        response = request_shutdown(control)
        assert response.status == 200, response.text()
        assert_browser_clean(sender, "removal failure sender")
        assert_browser_clean(receiver, "removal failure receiver")
        server.assert_stopped()
        assert not errors, errors
        mode = "normal return home" if return_home else "service shutdown"
        print(f"PASS OPFS cleanup failure during {mode}: HTTP 409, retained signaling owner, native-removal recovery permits clean retry", flush=True)


def verify_home_shutdown_overlap(browser, binary=None):
    # Normal navigation must not close the signal socket while an overlapping
    # shutdown request still needs that socket to acknowledge completed cleanup.
    with OwnedServer(binary) as server, real_pages(browser, server.base_url) as (sender, receiver, control, errors):
        connect_and_receive(sender, receiver)
        save_and_check(receiver)
        receiver.locator("#receiver-screen [data-action='back-home']").first.click()
        receiver.locator("#home-screen").wait_for(state="visible")
        assert len(receiver.evaluate(TEMPORARY_FILES)) == 1, "Download handoff must still be pending at shutdown"
        assert receiver.evaluate(RESOURCE_SNAPSHOT)["signaling"] == [1]
        response = request_shutdown(control)
        assert response.status == 200, f"Overlapping home cleanup lost the shutdown acknowledgement: {response.status} {response.text()}"
        assert_browser_clean(sender, "overlap sender")
        assert_browser_clean(receiver, "overlap receiver")
        server.assert_stopped()
        assert not errors, errors
        print("PASS home/shutdown overlap: pending download handoff completes before signaling acknowledgement and clean exit", flush=True)


def verify_cancelled_probe_reuse(browser, binary=None):
    # Successful removal after an ordinary AbortError is clean cancellation;
    # retaining it as a shutdown failure must not prevent the next room.
    with OwnedServer(binary) as server, real_pages(browser, server.base_url, receiver_script=HOLD_FIRST_STORAGE_PROBE) as (sender, receiver, control, errors):
        connect_and_receive(sender, receiver, complete=False, accept=False)
        receiver.wait_for_function("() => typeof __probeGate.release === 'function'", timeout=5_000)
        assert receiver.locator("#accept-files-button").is_disabled()
        receiver.once("dialog", lambda dialog: dialog.accept())
        receiver.locator("#receiver-screen [data-action='back-home']").first.click()
        receiver.locator("#home-screen").wait_for(state="visible")
        receiver.evaluate("() => __probeGate.release()")
        receiver.wait_for_function("""async () => {
          const root = await navigator.storage.getDirectory();
          for await (const name of root.keys()) if (name.startsWith('.dukou-')) return false;
          return true;
        }""", timeout=5_000)
        receiver.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        assert sender.evaluate("() => __shutdownProbe.sentBinaryBytes") == 0
        receiver.locator("#choose-sender").click()
        receiver.locator("#send-file-input").set_input_files({
            "name": "after-cancel.bin", "mimeType": "application/octet-stream", "buffer": b"new room after clean cancellation",
        })
        receiver.locator("#create-room-button").click()
        try:
            receiver.locator("#room-code").filter(has_text=re.compile(r"\d{3}\s\d{3}")).wait_for(timeout=5_000)
        except PlaywrightTimeoutError:
            raise AssertionError(f"Successful cancelled-probe cleanup prevented creating a new room: {receiver.evaluate(RESOURCE_SNAPSHOT)}") from None
        server.assert_alive()
        response = request_shutdown(control)
        assert response.status == 200, response.text()
        assert_browser_clean(sender, "cancelled probe sender")
        assert_browser_clean(receiver, "cancelled probe receiver and new room")
        server.assert_stopped()
        assert not errors, errors
        print("PASS cancelled preflight reuse: native probe removed, zero transfer bytes, next room usable and clean shutdown", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    cases = ["completed-saved", "unsaved-save", "unsaved-discard", "cancel-confirm", "active", "partial-batch", "cleanup-failure", "home-cleanup-failure", "home-shutdown-overlap", "cancelled-probe-reuse"]
    parser.add_argument("--case", choices=["all", *cases], default="all")
    parser.add_argument("--browser", choices=["auto", "chromium"], default="auto")
    parser.add_argument("--binary", type=Path, help="Run each case against this standalone binary instead of Bun source")
    args = parser.parse_args()
    with sync_playwright() as playwright:
        options = {"headless": True}
        path = find_browser() if args.browser == "auto" else None
        if path:
            options["executable_path"] = path
        browser = playwright.chromium.launch(**options)
        try:
            for case in cases if args.case == "all" else [args.case]:
                if case == "completed-saved":
                    verify_completed_saved(browser, args.binary)
                elif case in {"unsaved-save", "unsaved-discard"}:
                    verify_completed_unsaved(browser, args.binary, discard=case == "unsaved-discard")
                elif case == "cancel-confirm":
                    verify_cancelled_confirmation(browser, args.binary)
                elif case == "active":
                    verify_active_transfer(browser, args.binary)
                elif case == "partial-batch":
                    verify_partial_batch(browser, args.binary)
                elif case in {"cleanup-failure", "home-cleanup-failure"}:
                    verify_cleanup_failure(browser, args.binary, return_home=case == "home-cleanup-failure")
                elif case == "home-shutdown-overlap":
                    verify_home_shutdown_overlap(browser, args.binary)
                elif case == "cancelled-probe-reuse":
                    verify_cancelled_probe_reuse(browser, args.binary)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
