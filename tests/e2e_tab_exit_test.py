"""Real-browser lifecycle checks for closing the last local management tab.

Every case owns an ephemeral server and proves natural process exit before
failure-only teardown may terminate that process. Browser sessions, transfer
bytes, native confirmations, WebSockets and OPFS remain real.
"""

import argparse
from contextlib import contextmanager
from pathlib import Path
import time

from playwright.sync_api import sync_playwright

from e2e_shutdown_test import (
    FAIL_TEMPORARY_REMOVAL,
    FILENAME,
    OwnedServer,
    PAYLOAD,
    RESOURCE_SNAPSHOT,
    TEMPORARY_FILES,
    TRACK_RESOURCES,
    assert_browser_clean,
    connect_and_receive,
    find_browser,
    real_pages,
    request_shutdown,
    save_and_check,
)


# Observes native server messages; it neither blocks nor substitutes delivery.
OBSERVE_SERVICE_MESSAGES = """(() => {
  globalThis.__serviceMessages = [];
  const NativeSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        try {
          const message = JSON.parse(event.data);
          if (['manager_ready', 'service_shutdown', 'service_shutdown_cancelled'].includes(message.type)) {
            __serviceMessages.push(message);
          }
        } catch {}
      });
    }
  };
})();"""


def open_home(context, base_url, errors, label):
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(f"{label}: {error}"))
    page.goto(base_url)
    page.wait_for_load_state("networkidle")
    page.locator("#home-screen").wait_for(state="visible")
    return page


@contextmanager
def lifecycle_pages(browser, base_url, local_pages, scripts=None):
    """Create real pages; False only simulates a remote runtime permission.

    Browsers in this suite can only reach the isolated server on loopback.
    Preserve the full real runtime response except its one authorization flag;
    server-side nonloopback rejection is covered by the native server tests.
    """
    contexts, pages, errors = [], [], []

    def remote_runtime(route):
        response = route.fetch()
        runtime = response.json()
        runtime["canShutdown"] = False
        route.fulfill(response=response, json=runtime)

    try:
        for index, local in enumerate(local_pages):
            context = browser.new_context(viewport={"width": 1280, "height": 960}, accept_downloads=True)
            contexts.append(context)
            script = scripts[index] if scripts else ""
            context.add_init_script(TRACK_RESOURCES + "\n" + OBSERVE_SERVICE_MESSAGES + "\n" + script)
            if not local:
                context.route("**/api/runtime", remote_runtime)
            page = open_home(context, base_url, errors, f"page {index}")
            if local:
                page.locator("#shutdown-service-button").wait_for(state="visible")
            else:
                assert page.locator("#shutdown-service-button").is_hidden()
            pages.append(page)
        yield (*pages, errors)
    finally:
        for context in reversed(contexts):
            context.close()


def read_received_bytes(receiver, name):
    return bytes(receiver.evaluate("""async name => {
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle(name)).getFile();
      return Array.from(new Uint8Array(await file.arrayBuffer()));
    }""", name))


def wait_automatic_shutdown(page, after=0):
    page.wait_for_function(
        "after => __serviceMessages.filter(message => message.type === 'service_shutdown' && message.automatic === true).length > after",
        arg=after,
        timeout=10_000,
    )


def verify_home_close(browser, binary=None):
    # Losing the last idle manager must reach the process shutdown path even
    # when no transfer has ever opened a signaling connection.
    with OwnedServer(binary) as server:
        context = browser.new_context()
        try:
            page = context.new_page()
            page.goto(server.base_url)
            page.wait_for_load_state("networkidle")
            page.locator("#home-screen").wait_for(state="visible")
            server.assert_alive()
            closed_at = time.monotonic()
            page.close()
            time.sleep(4)
            server.assert_alive()
            server.assert_stopped()
            elapsed = time.monotonic() - closed_at
            assert 4.5 <= elapsed < 8, f"Expected a five-second close grace period, observed exit after {elapsed:.2f}s"
            print("PASS idle home close: last local tab causes owned PID to exit 0 and releases its port", flush=True)
        finally:
            context.close()


def verify_grace_cancellation(browser, binary=None, reopen=False):
    # Keeping an old disconnect timer after a new manager connects would shut
    # down the service while the refreshed/reopened page is still in use.
    with OwnedServer(binary) as server, lifecycle_pages(browser, server.base_url, [True]) as (page, errors):
        if reopen:
            context = page.context
            page.close()
            time.sleep(1.2)
            server.assert_alive()
            page = open_home(context, server.base_url, errors, "reopened manager")
        else:
            page.reload(wait_until="networkidle")
        page.wait_for_timeout(6_200)
        server.assert_alive()
        assert page.locator("#shutdown-notice").is_hidden()
        page.close()
        server.assert_stopped()
        assert not errors, errors
        action = "reopen" if reopen else "refresh"
        print(f"PASS {action}: manager reconnect cancels the old grace period; its eventual close exits cleanly", flush=True)


def verify_multiple_local_tabs(browser, binary=None):
    # A disconnect must count all remaining local managers, including idle
    # home pages that have never made a file-transfer signaling connection.
    with OwnedServer(binary) as server, lifecycle_pages(browser, server.base_url, [True, True]) as (first, second, errors):
        first.close()
        second.wait_for_timeout(6_200)
        server.assert_alive()
        assert second.locator("#shutdown-notice").is_hidden()
        second.close()
        server.assert_stopped()
        assert not errors, errors
        print("PASS multiple local tabs: first close keeps service alive; last close exits cleanly", flush=True)


def verify_remote_close(browser, binary=None):
    # Accidentally registering a remote page as a manager would make closing
    # that page shut down a host which has never opened a local manager.
    with OwnedServer(binary) as server, lifecycle_pages(browser, server.base_url, [False]) as (remote, errors):
        remote.close()
        time.sleep(6.2)
        server.assert_alive()
        context = browser.new_context()
        try:
            local = open_home(context, server.base_url, errors, "local manager")
            local.close()
            server.assert_stopped()
        finally:
            context.close()
        assert not errors, errors
        print("PASS remote-only page close: service stays alive until an actual local manager opens and closes", flush=True)


def verify_remote_completed_saved(browser, binary=None):
    # Auto shutdown must request actual browser cleanup before closing the
    # process; merely stopping HTTP leaves native RTC and temporary data alive.
    with OwnedServer(binary) as server, lifecycle_pages(browser, server.base_url, [False, False, True]) as (sender, receiver, control, errors):
        connect_and_receive(sender, receiver)
        save_and_check(receiver)
        control.close()
        wait_automatic_shutdown(receiver)
        assert_browser_clean(sender, "automatic saved sender")
        assert_browser_clean(receiver, "automatic saved receiver")
        server.assert_stopped()
        assert not errors, errors
        print("PASS automatic saved transfer: real bytes downloaded, RTC/WS/timers/OPFS cleaned, owned process exits 0", flush=True)


def verify_remote_unsaved(browser, binary=None, discard=False, cancel_discard=False):
    # A negative cleanup acknowledgement must preserve the only completed
    # copy. Saving/discarding it must retry without reopening a local control.
    with OwnedServer(binary) as server, lifecycle_pages(browser, server.base_url, [False, False, True]) as (sender, receiver, control, errors):
        connect_and_receive(sender, receiver)
        original_files = receiver.evaluate(TEMPORARY_FILES)
        assert len(original_files) == 1
        control.close()
        wait_automatic_shutdown(receiver)
        receiver.locator("#shutdown-status").filter(has_text="未保存").wait_for(state="visible", timeout=5_000)
        receiver.wait_for_timeout(600)
        server.assert_alive()
        assert receiver.evaluate(TEMPORARY_FILES) == original_files, "Automatic shutdown deleted an unsaved completed file"
        assert read_received_bytes(receiver, original_files[0]) == PAYLOAD, "Automatic shutdown corrupted retained bytes"
        assert receiver.get_by_role("button", name=f"保存 {FILENAME}", exact=True).is_enabled()
        if discard:
            confirmations = []

            def answer(dialog):
                confirmations.append(dialog.type)
                assert dialog.type == "confirm"
                if cancel_discard and len(confirmations) == 1:
                    dialog.dismiss()
                else:
                    dialog.accept()

            receiver.on("dialog", answer)
            back = receiver.locator("#receiver-screen [data-action='back-home']").first
            if cancel_discard:
                back.click()
                receiver.wait_for_timeout(600)
                assert confirmations == ["confirm"], "Discard must ask native confirmation"
                server.assert_alive()
                assert receiver.evaluate(TEMPORARY_FILES) == original_files, "Cancelled discard removed the received copy"
                assert read_received_bytes(receiver, original_files[0]) == PAYLOAD
                assert receiver.get_by_role("button", name=f"保存 {FILENAME}", exact=True).is_enabled()
            back.click()
            receiver.locator("#home-screen").wait_for(state="visible")
            assert len(confirmations) == (2 if cancel_discard else 1)
        else:
            save_and_check(receiver)
        assert_browser_clean(sender, "automatic unsaved sender")
        assert_browser_clean(receiver, "automatic unsaved receiver")
        server.assert_stopped()
        assert not errors, errors
        action = "cancelled then confirmed discard" if cancel_discard else "explicit discard" if discard else "byte-exact save"
        print(f"PASS automatic unsaved hold: only received copy retained; {action} triggers cleanup and natural exit without local tab", flush=True)


def verify_reopen_pending_shutdown(browser, binary=None):
    # A blocked automatic generation must lose authority when a new local
    # manager opens; a later save from that generation must not stop its host.
    with OwnedServer(binary) as server, lifecycle_pages(browser, server.base_url, [False, False, True]) as (sender, receiver, control, errors):
        connect_and_receive(sender, receiver)
        original_files = receiver.evaluate(TEMPORARY_FILES)
        assert len(original_files) == 1
        context = control.context
        control.close()
        wait_automatic_shutdown(receiver)
        receiver.locator("#shutdown-status").filter(has_text="未保存").wait_for(state="visible", timeout=5_000)
        reopened = open_home(context, server.base_url, errors, "reopened during unsaved hold")
        receiver.wait_for_function(
            "() => __serviceMessages.some(message => message.type === 'service_shutdown_cancelled')",
            timeout=5_000,
        )
        assert receiver.evaluate(TEMPORARY_FILES) == original_files
        assert read_received_bytes(receiver, original_files[0]) == PAYLOAD
        save_and_check(receiver)
        receiver.wait_for_timeout(6_200)
        server.assert_alive()
        assert reopened.locator("#shutdown-notice").is_hidden()
        notices = receiver.evaluate("() => __serviceMessages.filter(message => message.type === 'service_shutdown' && message.automatic === true).length")
        reopened.close()
        wait_automatic_shutdown(receiver, after=notices)
        assert_browser_clean(sender, "reopened pending sender")
        assert_browser_clean(receiver, "reopened pending receiver")
        server.assert_stopped()
        assert not errors, errors
        print("PASS reopen during unsaved hold: save cannot revive cancelled shutdown; later last-manager close cleans and exits", flush=True)


def verify_reopen_after_cleanup_failure(browser, binary=None):
    # Cancelling an automatic attempt must retain the signaling owner of a
    # failed native cleanup; otherwise a manual retry can report success while
    # leaving the temporary file behind in a disconnected receiver page.
    scripts = ["", FAIL_TEMPORARY_REMOVAL, ""]
    with OwnedServer(binary) as server, lifecycle_pages(browser, server.base_url, [False, False, True], scripts) as (sender, receiver, control, errors):
        connect_and_receive(sender, receiver)
        save_and_check(receiver)
        receiver.evaluate("() => { __removalFault.enabled = true; }")
        context = control.context
        control.close()
        wait_automatic_shutdown(receiver)
        receiver.wait_for_function("() => __removalFault.failures > 0", timeout=5_000)
        receiver.locator("#shutdown-status").filter(has_text="清理").wait_for(state="visible")
        assert len(receiver.evaluate(TEMPORARY_FILES)) == 1
        server.assert_alive()
        reopened = open_home(context, server.base_url, errors, "reopened after cleanup failure")
        receiver.wait_for_function(
            "() => __serviceMessages.some(message => message.type === 'service_shutdown_cancelled')",
            timeout=5_000,
        )
        receiver.evaluate("() => { __removalFault.enabled = false; }")
        response = request_shutdown(reopened)
        assert response.status == 200, response.text()
        assert_browser_clean(sender, "reopened cleanup failure sender")
        assert_browser_clean(receiver, "reopened cleanup failure receiver")
        server.assert_stopped()
        assert not errors, errors
        print("PASS reopen after native cleanup failure: retained signaling owner lets manual retry remove OPFS and exit cleanly", flush=True)


def verify_handoff_reopen_manual(browser, binary=None):
    # A new manual shutdown must inherit pending native cleanup without
    # inheriting the cancelled automatic attempt's suppressed acknowledgement.
    with OwnedServer(binary) as server, lifecycle_pages(browser, server.base_url, [False, False, True]) as (sender, receiver, control, errors):
        connect_and_receive(sender, receiver)
        context = control.context
        control.close()
        receiver.wait_for_timeout(4_000)
        save_and_check(receiver)
        wait_automatic_shutdown(receiver)
        assert len(receiver.evaluate(TEMPORARY_FILES)) == 1, "Native download handoff must still be pending during automatic cleanup"
        reopened = open_home(context, server.base_url, errors, "reopened during download handoff")
        receiver.wait_for_function(
            "() => __serviceMessages.some(message => message.type === 'service_shutdown_cancelled')",
            timeout=5_000,
        )
        assert len(receiver.evaluate(TEMPORARY_FILES)) == 1, "The cancelled cleanup must still own the real download handoff"
        response = request_shutdown(reopened)
        assert response.status == 200, f"Manual shutdown lost its acknowledgement after cancelling automatic handoff cleanup: {response.status} {response.text()}"
        assert_browser_clean(sender, "handoff cancellation sender")
        assert_browser_clean(receiver, "handoff cancellation receiver")
        server.assert_stopped()
        assert not errors, errors
        print("PASS handoff/reopen/manual overlap: fresh manual attempt receives pending cleanup acknowledgement and exits cleanly", flush=True)


def verify_cancelled_native_leave(browser, binary=None):
    # Destructive beforeunload handling would close RTC or delete the only
    # received copy even though the browser user chooses to stay on the page.
    with OwnedServer(binary) as server, real_pages(browser, server.base_url) as (sender, receiver, control, errors):
        connect_and_receive(sender, receiver)
        original_files = receiver.evaluate(TEMPORARY_FILES)
        assert len(original_files) == 1
        dialogs = []

        def stay(dialog):
            dialogs.append(dialog.type)
            dialog.dismiss()

        receiver.once("dialog", stay)
        receiver.close(run_before_unload=True)
        control.wait_for_timeout(300)
        assert dialogs == ["beforeunload"], "Leaving with an unsaved completed file must show a native beforeunload warning"
        assert not receiver.is_closed(), "Cancelling the native leave warning still closed the receiver"
        snapshot = receiver.evaluate(RESOURCE_SNAPSHOT)
        assert snapshot["rtc"] == ["connected"], f"Cancelled leave tore down the live RTC session: {snapshot}"
        assert snapshot["signaling"] == [1], f"Cancelled leave disconnected the live signaling session: {snapshot}"
        assert all(state == 1 for state in snapshot["sockets"]), f"Cancelled leave disconnected local management: {snapshot}"
        assert all(state == "open" for state in snapshot["channels"]), f"Cancelled leave closed the transfer channel: {snapshot}"
        assert receiver.evaluate(TEMPORARY_FILES) == original_files, "Cancelled leave deleted the unsaved received copy"
        assert receiver.get_by_role("button", name=f"保存 {FILENAME}", exact=True).is_enabled()
        server.assert_alive()
        save_and_check(receiver)
        response = request_shutdown(control)
        assert response.status == 200, response.text()
        assert_browser_clean(sender, "cancelled leave sender")
        assert_browser_clean(receiver, "cancelled leave receiver")
        server.assert_stopped()
        assert not errors, errors
        print("PASS cancelled native leave: live session and byte-exact received copy survive, then clean shutdown", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    cases = [
        "home-close", "refresh", "reopen", "multiple-local", "remote-close",
        "remote-saved", "remote-unsaved-save", "remote-unsaved-discard",
        "cancel-discard", "reopen-pending", "remote-cleanup-reopen", "handoff-reopen-manual", "cancel-native-leave",
    ]
    parser.add_argument("--case", choices=["all", *cases], default="all")
    parser.add_argument("--browser", choices=["auto", "chromium"], default="auto")
    parser.add_argument("--binary", type=Path, help="Run against this standalone binary instead of Bun source")
    args = parser.parse_args()
    with sync_playwright() as playwright:
        options = {"headless": True}
        path = find_browser() if args.browser == "auto" else None
        if path:
            options["executable_path"] = path
        browser = playwright.chromium.launch(**options)
        try:
            for case in cases if args.case == "all" else [args.case]:
                if case == "home-close":
                    verify_home_close(browser, args.binary)
                elif case in {"refresh", "reopen"}:
                    verify_grace_cancellation(browser, args.binary, reopen=case == "reopen")
                elif case == "multiple-local":
                    verify_multiple_local_tabs(browser, args.binary)
                elif case == "remote-close":
                    verify_remote_close(browser, args.binary)
                elif case == "remote-saved":
                    verify_remote_completed_saved(browser, args.binary)
                elif case in {"remote-unsaved-save", "remote-unsaved-discard", "cancel-discard"}:
                    verify_remote_unsaved(browser, args.binary, discard=case != "remote-unsaved-save", cancel_discard=case == "cancel-discard")
                elif case == "reopen-pending":
                    verify_reopen_pending_shutdown(browser, args.binary)
                elif case == "remote-cleanup-reopen":
                    verify_reopen_after_cleanup_failure(browser, args.binary)
                elif case == "handoff-reopen-manual":
                    verify_handoff_reopen_manual(browser, args.binary)
                elif case == "cancel-native-leave":
                    verify_cancelled_native_leave(browser, args.binary)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
