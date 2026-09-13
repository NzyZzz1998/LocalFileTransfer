"""Run the complete browser gate with owned servers and disposable screenshots.

Requires Bun, Python Playwright and either local Chrome or Playwright Chromium.
Never uses a server that is already listening on the selected test port.
"""

import argparse
from contextlib import contextmanager
import os
from pathlib import Path
import socket
import sys
import tempfile

import e2e_transfer_test as direct
import e2e_relay_lifecycle_test as lifecycle
import e2e_recovery_preflight_test as recovery
import ui_prototype_test as ui


@contextmanager
def arguments(module, *values):
    previous = sys.argv
    sys.argv = [module.__file__, *values]
    try:
        yield
    finally:
        sys.argv = previous


def run_suite(suite: str, base_url: str):
    print(f"RUN browser suite: {suite}", flush=True)
    if suite == "direct":
        for disabled in (False, True):
            with lifecycle.isolated_server(base_url, True, disabled):
                with arguments(direct, "--base-url", base_url):
                    direct.main()
            print(f"PASS direct transfer with relay {'disabled' if disabled else 'enabled'}", flush=True)
    elif suite == "ui":
        with lifecycle.isolated_server(base_url, True, False):
            previous = os.environ.get("DUKOU_TEST_URL")
            os.environ["DUKOU_TEST_URL"] = base_url
            try:
                ui.main()
            finally:
                if previous is None:
                    os.environ.pop("DUKOU_TEST_URL", None)
                else:
                    os.environ["DUKOU_TEST_URL"] = previous
        print("PASS desktop/narrow UI and live runtime relay", flush=True)
    elif suite == "lifecycle":
        for case in ("all", "disabled"):
            with arguments(lifecycle, "--start-server", "--base-url", base_url, "--case", case):
                lifecycle.main()
    elif suite == "recovery":
        with arguments(recovery, "--start-server", "--base-url", base_url, "--case", "all"):
            recovery.main()
    elif suite == "diagnostics":
        import e2e_diagnostics_test as diagnostics
        diagnostics.find_browser = direct.find_browser
        with arguments(diagnostics, "--start-server", "--base-url", base_url, "--case", "all"):
            diagnostics.main()
    elif suite == "shutdown":
        import e2e_shutdown_test as shutdown
        shutdown.find_browser = direct.find_browser
        # Shutdown asserts process exit, so every case must own its own server.
        with arguments(shutdown, "--case", "all"):
            shutdown.main()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=["all", "direct", "ui", "lifecycle", "recovery", "diagnostics", "shutdown"], default="all")
    parser.add_argument("--port", type=int, default=0, help="Exclusive local test port; 0 automatically selects an available port, never 3000")
    parser.add_argument("--browser", choices=["auto", "chromium"], default="auto", help="auto prefers installed Chrome; chromium uses Playwright's pinned browser")
    parser.add_argument("--artifacts-dir", type=Path, help="Optional CI screenshot directory; default is disposable")
    args = parser.parse_args()
    if args.port == 3000 or (args.port != 0 and not 1024 <= args.port <= 65535):
        parser.error("Choose 0 or an unoccupied test port from 1024 to 65535, excluding user port 3000")
    if args.port == 0:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            args.port = probe.getsockname()[1]
        # isolated_server rechecks binding immediately before every launch.
    print(f"Browser gate owns test port {args.port}", flush=True)
    if args.browser == "chromium":
        for module in (direct, lifecycle, recovery, ui):
            module.find_browser = lambda: None
    with tempfile.TemporaryDirectory(prefix="dukou-browser-gate-") as temporary:
        screenshots = (args.artifacts_dir or Path(temporary)).resolve()
        tracked = (Path(__file__).resolve().parents[1] / "artifacts/screenshots").resolve()
        if screenshots == tracked or tracked in screenshots.parents:
            parser.error("Do not overwrite tracked prototype screenshots; select a temporary CI directory")
        screenshots.mkdir(parents=True, exist_ok=True)
        direct.SCREENSHOTS = screenshots
        ui.SCREENSHOTS = screenshots
        suites = ["direct", "ui", "lifecycle", "recovery", "diagnostics", "shutdown"] if args.suite == "all" else [args.suite]
        for suite in suites:
            run_suite(suite, f"http://127.0.0.1:{args.port}")
    print(f"PASS browser gate: {', '.join(suites)}", flush=True)


if __name__ == "__main__":
    main()
