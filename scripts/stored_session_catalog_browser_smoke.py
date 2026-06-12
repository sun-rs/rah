from __future__ import annotations

import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any
from urllib import request

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import expect, sync_playwright


ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent


def free_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return int(port)


def request_json(base_url: str, path: str, timeout: float = 20) -> dict[str, Any]:
    with request.urlopen(f"{base_url}{path}", timeout=timeout) as response:
        body = response.read()
    return json.loads(body) if body else {}


def wait_for_daemon(base_url: str, timeout_s: float = 30) -> None:
    started = time.time()
    last_error: Exception | None = None
    while time.time() - started < timeout_s:
        try:
            request_json(base_url, "/api/sessions", timeout=2)
            return
        except Exception as exc:  # pragma: no cover - diagnostic only
            last_error = exc
            time.sleep(0.2)
    raise RuntimeError(f"daemon did not become ready: {last_error}")


def write_codex_rollout(
    codex_home: pathlib.Path,
    *,
    session_id: str,
    workspace: pathlib.Path,
    title: str,
    turns: int,
    minute_offset: int,
) -> pathlib.Path:
    target_dir = codex_home / "sessions" / "2026" / "06" / "12"
    target_dir.mkdir(parents=True, exist_ok=True)
    workspace.mkdir(parents=True, exist_ok=True)
    rollout_path = target_dir / f"rollout-2026-06-12T00-00-00-{session_id}.jsonl"
    lines: list[dict[str, Any]] = [
        {
            "timestamp": f"2026-06-12T08:{minute_offset:02d}:00.000Z",
            "type": "session_meta",
            "payload": {
                "id": session_id,
                "timestamp": f"2026-06-12T08:{minute_offset:02d}:00.000Z",
                "cwd": str(workspace),
                "source": "cli",
            },
        },
        {
            "timestamp": f"2026-06-12T08:{minute_offset:02d}:01.000Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "id": f"{session_id}-user-title",
                "content": [{"type": "input_text", "text": title}],
            },
        },
    ]
    for index in range(1, turns + 1):
        second = index % 60
        minute = minute_offset + (index // 60)
        lines.append(
            {
                "timestamp": f"2026-06-12T08:{minute:02d}:{second:02d}.000Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "id": f"{session_id}-assistant-{index}",
                    "content": [
                        {
                            "type": "output_text",
                            "text": f"{title} assistant answer {index} with stable browser smoke content",
                        },
                    ],
                },
            }
        )
        if index % 7 == 0:
            lines.append(
                {
                    "timestamp": f"2026-06-12T08:{minute:02d}:{min(second + 1, 59):02d}.000Z",
                    "type": "event_msg",
                    "payload": {"type": "token_count", "info": None},
                }
            )
    rollout_path.write_text("\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf8")
    mtime = time.time() + minute_offset
    os.utime(rollout_path, (mtime, mtime))
    return rollout_path


def build_web_if_needed() -> None:
    if os.environ.get("RAH_SKIP_BROWSER_SMOKE_BUILD") == "1":
      return
    subprocess.run(["npm", "run", "build:web"], cwd=ROOT_DIR, check=True)


def start_daemon(port: int, temp_root: pathlib.Path) -> subprocess.Popen[str]:
    env = {
        **os.environ,
        "RAH_PORT": str(port),
        "RAH_HOST": "127.0.0.1",
        "RAH_HOME": str(temp_root / "rah-home"),
        "CODEX_HOME": str(temp_root / "codex-home"),
        "CLAUDE_CONFIG_DIR": str(temp_root / "claude-home"),
        "GEMINI_CLI_HOME": str(temp_root / "gemini-home"),
        "XDG_DATA_HOME": str(temp_root / "xdg-data"),
    }
    return subprocess.Popen(
        ["node", "--import", "tsx", "packages/runtime-daemon/src/main.ts"],
        cwd=ROOT_DIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )


@dataclass
class ApiResponseRecord:
    step: str
    method: str
    url: str
    status: int
    bytes: int
    elapsed_ms: int


@dataclass
class BrowserMetrics:
    records: list[ApiResponseRecord] = field(default_factory=list)
    current_step: str = "setup"
    all_revisions: list[int] = field(default_factory=list)

    @contextmanager
    def step(self, name: str):
        previous = self.current_step
        self.current_step = name
        started = len(self.records)
        start_time = time.time()
        try:
            yield
        finally:
            elapsed_ms = int((time.time() - start_time) * 1000)
            self.current_step = previous
            print(
                json.dumps(
                    {
                        "step": name,
                        "elapsedMs": elapsed_ms,
                        "apiRequests": [record.__dict__ for record in self.records[started:]],
                    },
                    ensure_ascii=False,
                )
            )

    def add(self, record: ApiResponseRecord) -> None:
        self.records.append(record)

    def by_step(self, step: str) -> list[ApiResponseRecord]:
        return [record for record in self.records if record.step == step]


def response_size(response) -> int:
    header = response.headers.get("content-length")
    if header:
        try:
            return int(header)
        except ValueError:
            pass
    try:
        return len(response.body())
    except Exception:
        return 0


def assert_no_full_all(records: list[ApiResponseRecord], step: str) -> None:
    offenders = [
        record.url
        for record in records
        if "/api/sessions?storedSessions=all" in record.url
    ]
    if offenders:
        raise AssertionError(f"{step} unexpectedly fetched full All catalog: {offenders}")


def assert_full_all_count(records: list[ApiResponseRecord], expected: int, step: str) -> None:
    count = sum(1 for record in records if "/api/sessions?storedSessions=all" in record.url)
    if count != expected:
        raise AssertionError(f"{step} expected {expected} full All fetches, got {count}")


def main() -> int:
    artifact_root = ROOT_DIR / "test-results" / "stored-session-catalog-browser" / str(int(time.time()))
    artifact_root.mkdir(parents=True, exist_ok=True)
    temp_root = pathlib.Path(tempfile.mkdtemp(prefix="rah-catalog-browser-"))
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    daemon: subprocess.Popen[str] | None = None
    try:
        codex_home = temp_root / "codex-home"
        workspace_a = temp_root / "workspace-alpha"
        workspace_b = temp_root / "workspace-beta"
        big_session_id = str(uuid.uuid4())
        small_session_id = str(uuid.uuid4())
        big_title = "RAH E2E Big Session Catalog Tail"
        small_title = "RAH E2E Small Session Catalog"
        write_codex_rollout(
            codex_home,
            session_id=big_session_id,
            workspace=workspace_a,
            title=big_title,
            turns=700,
            minute_offset=1,
        )
        write_codex_rollout(
            codex_home,
            session_id=small_session_id,
            workspace=workspace_b,
            title=small_title,
            turns=12,
            minute_offset=2,
        )
        for index in range(24):
            write_codex_rollout(
                codex_home,
                session_id=str(uuid.uuid4()),
                workspace=workspace_b,
                title=f"RAH E2E Recent Filler {index:02d}",
                turns=2,
                minute_offset=10 + index,
            )

        build_web_if_needed()
        daemon = start_daemon(port, temp_root)
        wait_for_daemon(base_url)

        metrics = BrowserMetrics()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 900})
            page.set_default_timeout(30_000)
            page.add_init_script(
                """
                (() => {
                  const NativeWS = window.WebSocket;
                  window.__rahSocketMessages = [];
                  window.WebSocket = function(url, protocols) {
                    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
                    ws.addEventListener('message', (event) => {
                      try { window.__rahSocketMessages.push(JSON.parse(event.data)); } catch {}
                    });
                    return ws;
                  };
                  window.WebSocket.prototype = NativeWS.prototype;
                })();
                """
            )

            def on_response(response):
                if not response.url.startswith(base_url) or "/api/" not in response.url:
                    return
                started = time.time()
                size = response_size(response)
                elapsed_ms = int((time.time() - started) * 1000)
                metrics.add(
                    ApiResponseRecord(
                        step=metrics.current_step,
                        method=response.request.method,
                        url=response.url.replace(base_url, ""),
                        status=response.status,
                        bytes=size,
                        elapsed_ms=elapsed_ms,
                    )
                )
                if "/api/sessions?storedSessions=all" in response.url and response.status == 200:
                    try:
                        body = json.loads(response.body())
                        revision = body.get("storedSessionsRevision")
                        if isinstance(revision, int):
                            metrics.all_revisions.append(revision)
                    except Exception:
                        pass

            page.on("response", on_response)

            with metrics.step("initial_load"):
                page.goto(base_url, wait_until="domcontentloaded")
                expect(page.locator('button[aria-label="Chats"]:visible').first).to_be_visible(timeout=30_000)
            assert_no_full_all(metrics.by_step("initial_load"), "initial_load")

            with metrics.step("first_all_catalog"):
                page.locator('button[aria-label="Chats"]:visible').first.click()
                expect(page.get_by_role("heading", name="Chats")).to_be_visible(timeout=30_000)
                page.get_by_role("tab", name="All", exact=True).click()
                page.get_by_placeholder("Search chats").fill(big_title)
                row = page.locator(f'button[data-provider-session-id="{big_session_id}"]:visible').first
                expect(row).to_be_visible(timeout=30_000)
            assert_full_all_count(metrics.by_step("first_all_catalog"), 1, "first_all_catalog")
            if not metrics.all_revisions:
                raise AssertionError("first All response did not expose storedSessionsRevision")

            with metrics.step("clean_all_reopen"):
                page.locator('button[aria-label="Close"]:visible').first.click()
                page.locator('button[aria-label="Chats"]:visible').first.click()
                expect(page.get_by_role("heading", name="Chats")).to_be_visible(timeout=30_000)
                page.get_by_role("tab", name="All", exact=True).click()
                page.get_by_placeholder("Search chats").fill(small_title)
                expect(page.locator(f'button[data-provider-session-id="{small_session_id}"]:visible').first).to_be_visible(timeout=30_000)
            assert_no_full_all(metrics.by_step("clean_all_reopen"), "clean_all_reopen")

            with metrics.step("open_large_history"):
                page.get_by_placeholder("Search chats").fill(big_title)
                page.locator(f'button[data-provider-session-id="{big_session_id}"]:visible').first.click()
                expect(page.get_by_text(f"{big_title} assistant answer 700").first).to_be_visible(timeout=45_000)
            history_records = [
                record
                for record in metrics.by_step("open_large_history")
                if f"/api/sessions/" in record.url and "/history" in record.url
            ]
            if not history_records:
                raise AssertionError("opening large history did not request a history page")
            max_history_bytes = max(record.bytes for record in history_records)
            if max_history_bytes > 180_000:
                raise AssertionError(f"large history initial page too large: {max_history_bytes} bytes")
            assert_no_full_all(metrics.by_step("open_large_history"), "open_large_history")

            with metrics.step("delete_history_from_all"):
                page.locator('button[aria-label="Chats"]:visible').first.click()
                expect(page.get_by_role("heading", name="Chats")).to_be_visible(timeout=30_000)
                page.get_by_role("tab", name="All", exact=True).click()
                page.get_by_placeholder("Search chats").fill(small_title)
                small_row = page.locator(f'div[data-provider-session-id="{small_session_id}"]:visible').first
                expect(small_row).to_be_visible(timeout=30_000)
                small_row.locator('button[aria-label="Delete session"]').click()
                expect(page.get_by_role("heading", name="Delete session?")).to_be_visible(timeout=30_000)
                page.get_by_role("button", name="Delete", exact=True).click()
                expect(page.locator(f'div[data-provider-session-id="{small_session_id}"]:visible')).to_have_count(0, timeout=30_000)
            assert_no_full_all(metrics.by_step("delete_history_from_all"), "delete_history_from_all")
            delete_delta = request_json(
                base_url,
                f"/api/sessions/stored-delta?since={metrics.all_revisions[0]}",
            )
            if not any(
                item.get("provider") == "codex" and item.get("providerSessionId") == small_session_id
                for item in delete_delta.get("remove", [])
                if isinstance(item, dict)
            ):
                raise AssertionError(f"delete delta did not include removed session: {delete_delta}")

            page.screenshot(path=str(artifact_root / "final.png"), full_page=False)
            browser.close()

        metrics_path = artifact_root / "metrics.json"
        metrics_path.write_text(
            json.dumps(
                {
                    "baseUrl": base_url,
                    "tempRoot": str(temp_root),
                    "records": [record.__dict__ for record in metrics.records],
                    "allRevisions": metrics.all_revisions,
                    "deleteDelta": delete_delta,
                    "observations": [
                        "Production default StoredSessionMonitor uses periodic reconcile for external provider-history file additions; this smoke asserts UI/API-owned catalog mutations instead.",
                    ],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf8",
        )
        print(json.dumps({"ok": True, "artifactDir": str(artifact_root)}, ensure_ascii=False, indent=2))
        return 0
    except PlaywrightTimeoutError as exc:
        print(f"browser smoke timed out: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"browser smoke failed: {exc}", file=sys.stderr)
        return 1
    finally:
        if daemon is not None and daemon.poll() is None:
            daemon.terminate()
            try:
                daemon.wait(timeout=10)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait(timeout=5)
        if os.environ.get("RAH_KEEP_BROWSER_SMOKE_STATE") != "1":
            shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
