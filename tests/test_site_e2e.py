"""Runs tests/e2e/site.e2e.js against a local static server. It drives the real page
in Chromium with the bundled SDKs and intercepts every external API. Skipped when
node or the playwright package is not available."""
import shutil
import socket
import subprocess
import sys
import time

import pytest

from app.config import DOCS_DIR, ROOT

node = shutil.which("node")


def _has_playwright() -> bool:
    if not node:
        return False
    return subprocess.run([node, "-e", "require('playwright')"], capture_output=True, cwd=ROOT).returncode == 0


@pytest.mark.skipif(not _has_playwright(), reason="node + playwright not installed")
def test_static_site_end_to_end():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1", "--directory", str(DOCS_DIR)],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        out = subprocess.run([node, str(ROOT / "tests" / "e2e" / "site.e2e.js"), f"http://127.0.0.1:{port}/"],
                             capture_output=True, text=True, timeout=180, cwd=ROOT)
        assert out.returncode == 0 and "E2E PASSED" in out.stdout, out.stdout + out.stderr
    finally:
        server.terminate()
