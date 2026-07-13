from __future__ import annotations

import json
import os
import pathlib
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

from safe_trash import move_path_to_trash


ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent


def free_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return int(port)


def request_json(
    base_url: str,
    path: str,
    *,
    timeout: float = 20,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = None if body is None else json.dumps(body).encode("utf8")
    request_headers = dict(headers or {})
    if payload is not None:
        request_headers["content-type"] = "application/json"
    http_request = request.Request(
        f"{base_url}{path}",
        data=payload,
        headers=request_headers,
        method=method,
    )
    with request.urlopen(http_request, timeout=timeout) as response:
        body = response.read()
    return json.loads(body) if body else {}


def wait_for_daemon(base_url: str, timeout_s: float = 30) -> None:
    started = time.time()
    last_error: Exception | None = None
    while time.time() - started < timeout_s:
        try:
            request_json(base_url, "/api/auth/status", timeout=2)
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
    ]
    for index in range(1, turns + 1):
        second = index % 60
        minute = minute_offset + (index // 60)
        timestamp_prefix = f"2026-06-12T08:{minute:02d}:{second:02d}"
        turn_id = f"{session_id}-turn-{index}"
        user_text = title if index == 1 else f"{title} follow-up {index}"
        assistant_text = f"{title} assistant answer {index} with stable browser smoke content"
        lines.extend(
            [
                {
                    "timestamp": f"{timestamp_prefix}.000Z",
                    "type": "event_msg",
                    "payload": {"type": "task_started", "turn_id": turn_id},
                },
                {
                    "timestamp": f"{timestamp_prefix}.100Z",
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "id": f"{session_id}-user-{index}",
                        "content": [{"type": "input_text", "text": user_text}],
                    },
                },
                {
                    "timestamp": f"{timestamp_prefix}.200Z",
                    "type": "event_msg",
                    "payload": {
                        "type": "agent_message",
                        "message": assistant_text,
                        "phase": "final_answer",
                    },
                },
                {
                    "timestamp": f"{timestamp_prefix}.300Z",
                    "type": "event_msg",
                    "payload": {
                        "type": "task_complete",
                        "turn_id": turn_id,
                        "last_agent_message": assistant_text,
                        "duration_ms": 300,
                    },
                },
            ]
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
    daemon_url = f"http://127.0.0.1:{port}"
    # Resolve to loopback while retaining a non-loopback Host so this smoke exercises
    # the real remote-device pairing boundary instead of the direct-local bypass.
    base_url = f"http://rah-auth.localhost:{port}"
    daemon: subprocess.Popen[str] | None = None
    try:
        codex_home = temp_root / "codex-home"
        workspace_a = temp_root / "workspace-alpha"
        workspace_b = temp_root / "workspace-beta"
        big_session_id = str(uuid.uuid4())
        pwa_session_id = str(uuid.uuid4())
        small_session_id = str(uuid.uuid4())
        big_title = "RAH E2E Big Session Catalog Tail"
        pwa_title = "RAH E2E PWA Big Session Catalog Tail"
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
            session_id=pwa_session_id,
            workspace=workspace_a,
            title=pwa_title,
            turns=700,
            minute_offset=3,
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
        wait_for_daemon(daemon_url)
        management_token = (temp_root / "rah-home" / "auth" / "management-token").read_text(
            encoding="utf8"
        ).strip()
        pairing = request_json(
            daemon_url,
            "/api/auth/pairing-code",
            method="POST",
            headers={"authorization": f"Bearer {management_token}"},
            body={},
        )
        pairing_code = pairing.get("code")
        if not isinstance(pairing_code, str) or len(pairing_code) != 8:
            raise AssertionError(f"daemon returned an invalid pairing code: {pairing}")

        metrics = BrowserMetrics()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            page = context.new_page()
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

            def reveal_session_row(session_id: str, workspace_name: str, target_page=page):
                row = target_page.locator(
                    f'button[data-provider-session-id="{session_id}"]:visible'
                ).first
                if not row.is_visible():
                    group = target_page.locator("section").filter(
                        has_text=workspace_name
                    ).locator(":scope > button").first
                    expect(group).to_be_visible(timeout=30_000)
                    group.click()
                return row

            with metrics.step("initial_load"):
                page.goto(base_url, wait_until="domcontentloaded")
                expect(page.get_by_role("heading", name="Trust this device")).to_be_visible(
                    timeout=30_000
                )
                page.get_by_label("Device name").fill("Catalog browser smoke")
                page.get_by_label("8 digit pairing code").fill(pairing_code)
                page.get_by_role("button", name="Trust device").click()
                expect(page.locator('button[aria-label="Chats"]:visible').first).to_be_visible(timeout=30_000)
            assert_no_full_all(metrics.by_step("initial_load"), "initial_load")

            with metrics.step("first_all_catalog"):
                page.locator('button[aria-label="Chats"]:visible').first.click()
                expect(page.get_by_role("heading", name="Chats")).to_be_visible(timeout=30_000)
                page.get_by_role("tab", name="All", exact=True).click()
                page.get_by_placeholder("Search chats").fill(big_title)
                row = reveal_session_row(big_session_id, workspace_a.name)
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
                expect(reveal_session_row(small_session_id, workspace_b.name)).to_be_visible(timeout=30_000)
            assert_no_full_all(metrics.by_step("clean_all_reopen"), "clean_all_reopen")

            with metrics.step("open_large_history"):
                page.get_by_placeholder("Search chats").fill(big_title)
                reveal_session_row(big_session_id, workspace_a.name).click()
                expect(page.get_by_text(f"{big_title} assistant answer 700").first).to_be_visible(timeout=45_000)
            conversation_records = [
                record
                for record in metrics.by_step("open_large_history")
                if f"/api/sessions/" in record.url and "/conversation/turns" in record.url
            ]
            if not conversation_records:
                raise AssertionError("opening large history did not request a Conversation page")
            max_conversation_bytes = max(record.bytes for record in conversation_records)
            if max_conversation_bytes > 180_000:
                raise AssertionError(
                    f"large history initial Conversation page too large: {max_conversation_bytes} bytes"
                )
            assert_no_full_all(metrics.by_step("open_large_history"), "open_large_history")

            with metrics.step("open_large_history_pwa"):
                pwa_page = context.new_page()
                pwa_page.set_viewport_size({"width": 390, "height": 844})
                pwa_page.add_init_script(
                    "Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });"
                )
                pwa_page.on("response", on_response)
                pwa_page.goto(base_url, wait_until="domcontentloaded")
                pwa_chats_button = pwa_page.locator('button[aria-label="Chats"]:visible').first
                if not pwa_chats_button.is_visible():
                    open_sidebar_button = pwa_page.locator(
                        'button[aria-label="Open sidebar"]:visible, '
                        'button[aria-label="Expand sidebar"]:visible'
                    ).first
                    expect(open_sidebar_button).to_be_visible(timeout=30_000)
                    open_sidebar_button.click()
                expect(pwa_chats_button).to_be_visible(timeout=30_000)
                pwa_chats_button.click()
                expect(pwa_page.get_by_role("heading", name="Chats")).to_be_visible(timeout=30_000)
                pwa_page.get_by_role("tab", name="All", exact=True).click()
                pwa_page.get_by_placeholder("Search chats").fill(pwa_title)
                reveal_session_row(pwa_session_id, workspace_a.name, pwa_page).click()
                expect(
                    pwa_page.get_by_text(f"{pwa_title} assistant answer 700").first
                ).to_be_visible(timeout=45_000)
                expect(pwa_page.locator('[data-turn-navigation="hidden"]')).to_be_visible()
                pwa_page.screenshot(
                    path=str(artifact_root / "pwa-large-history.png"),
                    full_page=False,
                )
                pwa_page.close()
            pwa_records = metrics.by_step("open_large_history_pwa")
            pwa_directory_requests = [
                record.url for record in pwa_records if "/conversation/directory" in record.url
            ]
            if pwa_directory_requests:
                raise AssertionError(
                    f"PWA history unexpectedly requested the desktop turn directory: "
                    f"{pwa_directory_requests}"
                )
            pwa_conversation_records = [
                record
                for record in pwa_records
                if "/api/sessions/" in record.url and "/conversation/turns" in record.url
            ]
            if not pwa_conversation_records:
                raise AssertionError("opening large PWA history did not request a Conversation page")
            max_pwa_conversation_bytes = max(record.bytes for record in pwa_conversation_records)
            if max_pwa_conversation_bytes > 180_000:
                raise AssertionError(
                    f"large PWA history initial Conversation page too large: "
                    f"{max_pwa_conversation_bytes} bytes"
                )

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
            delete_delta_response = context.request.get(
                f"{base_url}/api/sessions/stored-delta?since={metrics.all_revisions[0]}"
            )
            if not delete_delta_response.ok:
                raise AssertionError(
                    f"delete delta request failed: {delete_delta_response.status} "
                    f"{delete_delta_response.text()}"
                )
            delete_delta = delete_delta_response.json()
            if not any(
                item.get("provider") == "codex" and item.get("providerSessionId") == small_session_id
                for item in delete_delta.get("remove", [])
                if isinstance(item, dict)
            ):
                raise AssertionError(f"delete delta did not include removed session: {delete_delta}")

            page.screenshot(path=str(artifact_root / "final.png"), full_page=False)
            context.close()
            browser.close()

        metrics_path = artifact_root / "metrics.json"
        metrics_path.write_text(
            json.dumps(
                {
                    "baseUrl": base_url,
                    "daemonUrl": daemon_url,
                    "tempRoot": str(temp_root),
                    "records": [record.__dict__ for record in metrics.records],
                    "allRevisions": metrics.all_revisions,
                    "deleteDelta": delete_delta,
                    "observations": [
                        "The browser was paired through the real device-auth UI before accessing protected HTTP and WebSocket APIs.",
                        "Production startup serves the last-good catalog snapshot immediately, then reconciles provider histories in isolated workers; this smoke also asserts UI/API-owned catalog mutations.",
                        "The PWA large-history path transfers a bounded 20-turn page and does not request the desktop conversation directory.",
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
            move_path_to_trash(temp_root)


if __name__ == "__main__":
    raise SystemExit(main())
