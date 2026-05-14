from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import uuid
from typing import Any
from urllib import error, request

from playwright.sync_api import expect, sync_playwright

from native_smoke_process import terminate_process_tree


ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent
SCREENSHOTS: list[str] = []
CASE_IDS = [
    "TRANSCRIPT-ORDER-001",
    "TRANSCRIPT-UNIQUE-001",
    "TRANSCRIPT-REPEAT-001",
    "INTERRUPT-ANCHOR-001",
    "INTERRUPT-MULTI-001",
    "INTERRUPT-STATE-001",
    "QUEUE-INPUT-001",
    "NEW-SESSION-001",
    "REFRESH-LIVE-001",
    "HISTORY-PAGING-001",
    "HISTORY-CLAIM-001",
    "CODEX-EVENT-001",
    "TUI-SURFACE-001",
    "TUI-EXIT-001",
    "ARCHIVE-001",
    "MISSING-CWD-001",
    "MOBILE-COMPOSER-001",
    "MOBILE-TUI-001",
]


def selected_browser_name() -> str:
    return os.environ.get("RAH_NATIVE_BROWSER", "chromium").strip().lower()


def browser_headless() -> bool:
    return os.environ.get("RAH_NATIVE_HEADLESS", "1") != "0"


def browser_supports_mobile_context() -> bool:
    # Playwright Firefox does not implement Browser.newContext({ isMobile }).
    # Keep Firefox in the desktop smoke matrix instead of failing on a
    # browser-runtime limitation unrelated to RAH.
    return selected_browser_name() != "firefox"


def launch_browser(playwright):
    browser_name = selected_browser_name()
    browser_types = {
        "chromium": playwright.chromium,
        "firefox": playwright.firefox,
        "webkit": playwright.webkit,
    }
    browser_type = browser_types.get(browser_name)
    if browser_type is None:
        expected = ", ".join(sorted(browser_types))
        raise RuntimeError(f"unsupported RAH_NATIVE_BROWSER={browser_name!r}; expected one of: {expected}")
    return browser_type.launch(headless=browser_headless())


def preflight_browser_runtime() -> None:
    with sync_playwright() as playwright:
        browser = launch_browser(playwright)
        browser.close()


def browser_artifact_dir(suite: str) -> pathlib.Path:
    raw = os.environ.get("RAH_BROWSER_E2E_ARTIFACT_DIR", "test-results/browser-e2e")
    root = pathlib.Path(raw)
    if not root.is_absolute():
        root = ROOT_DIR / root
    path = root / suite / str(int(time.time()))
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_browser_screenshot(page, artifact_dir: pathlib.Path, name: str) -> None:
    path = artifact_dir / f"{name}.png"
    page.screenshot(path=str(path), full_page=False)
    SCREENSHOTS.append(str(path.relative_to(ROOT_DIR) if path.is_relative_to(ROOT_DIR) else path))


def request_json(base_url: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    if payload is None:
        req = request.Request(f"{base_url}{path}")
    else:
        req = request.Request(
            f"{base_url}{path}",
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
        )
    try:
        with request.urlopen(req, timeout=120) as response:
            body = response.read()
            return json.loads(body) if body else {}
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} {exc.reason} for {path}: {body}") from exc


def close_session_quietly(base_url: str, session_id: str | None) -> None:
    if not session_id:
        return
    try:
        request_json(base_url, f"/api/sessions/{session_id}/close", {"clientId": "web-user"})
    except Exception:
        pass


def mark_session_closed(base_url: str, session_id: str | None) -> None:
    if session_id:
        close_session_quietly(base_url, session_id)


def live_session_ids(base_url: str) -> set[str]:
    response = request_json(base_url, "/api/sessions")
    return {
        str(entry.get("session", {}).get("id"))
        for entry in response.get("sessions", [])
        if entry.get("session", {}).get("provider") == "codex"
        and entry.get("session", {}).get("id")
    }


def wait_for_new_live_session(
    base_url: str,
    before: set[str],
    timeout_s: int = 60,
    proc: subprocess.Popen[str] | None = None,
) -> str:
    started = time.time()
    last_sessions: list[dict[str, Any]] = []
    while time.time() - started < timeout_s:
        response = request_json(base_url, "/api/sessions")
        sessions = [
            entry.get("session", {})
            for entry in response.get("sessions", [])
            if entry.get("session", {}).get("provider") == "codex"
            and str(entry.get("session", {}).get("id")) not in before
        ]
        last_sessions = sessions
        if sessions:
            sessions.sort(key=lambda item: str(item.get("createdAt", "")), reverse=True)
            return str(sessions[0]["id"])
        if proc is not None and proc.poll() is not None:
            stdout = ""
            stderr = ""
            try:
                stdout, stderr = proc.communicate(timeout=1)
            except Exception:
                pass
            raise AssertionError(
                "new Codex live session did not appear before rah codex exited; "
                f"code={proc.returncode} stdout={stdout[-2000:]} stderr={stderr[-2000:]} "
                f"last={last_sessions}"
            )
        time.sleep(0.2)
    raise AssertionError(f"new Codex live session did not appear; last={last_sessions}")


def spawn_rah_codex_cli(
    base_url: str,
    workspace: pathlib.Path,
    provider_session_id: str | None = None,
) -> subprocess.Popen[str]:
    args = ["node", "bin/rah.mjs", "codex"]
    if provider_session_id:
        args.extend(["resume", provider_session_id])
    args.extend(["--daemon-url", base_url, "--cwd", str(workspace)])
    return subprocess.Popen(
        args,
        cwd=ROOT_DIR,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=os.environ,
    )


def terminate_cli_process(proc: subprocess.Popen[str] | None) -> None:
    if not proc or proc.poll() is not None:
        return
    terminate_process_tree(proc)


def start_rah_codex_cli_session(
    base_url: str,
    workspace: pathlib.Path,
    before: set[str],
) -> tuple[subprocess.Popen[str], str]:
    last_error: AssertionError | None = None
    for attempt in range(2):
        proc = spawn_rah_codex_cli(base_url, workspace)
        try:
            return proc, wait_for_new_live_session(base_url, before, proc=proc)
        except AssertionError as exc:
            last_error = exc
            terminate_cli_process(proc)
            message = str(exc)
            if "Codex app-server request timed out: initialize" not in message or attempt > 0:
                raise
            time.sleep(1)
    assert last_error is not None
    raise last_error


def open_live_session(page, session_id: str) -> None:
    page.locator('button[aria-label="Sessions"]:visible').first.click(timeout=30_000)
    page.get_by_role("button", name="Live", exact=True).click(timeout=30_000)
    page.locator(f'button[data-session-id="{session_id}"]:visible').first.click(timeout=30_000)


def free_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return int(port)


def write_fake_codex(path: pathlib.Path) -> None:
    path.write_text(
        "\n".join(
            [
                "#!/usr/bin/env node",
                "const fs = require('node:fs');",
                "const path = require('node:path');",
                "const baseProviderSessionId = process.env.MOCK_CODEX_SESSION_ID;",
                "const codexHome = process.env.CODEX_HOME;",
                "if (!baseProviderSessionId || !codexHome) process.exit(2);",
                "const resumeIndex = process.argv.indexOf('resume');",
                "const providerSessionId = resumeIndex >= 0 && process.argv[resumeIndex + 1] ? process.argv[resumeIndex + 1] : `${baseProviderSessionId}-${process.pid}`;",
                "const rolloutPath = path.join(codexHome, 'sessions', `rollout-native-browser-${providerSessionId}.jsonl`);",
                "fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });",
                "function append(row) { fs.appendFileSync(rolloutPath, JSON.stringify(row) + '\\n'); }",
                "function timestamp(offsetMs = 0) { return new Date(Date.now() + offsetMs).toISOString(); }",
                "append({ timestamp: timestamp(), type: 'session_meta', payload: { id: providerSessionId, cwd: process.cwd(), timestamp: timestamp() } });",
                "process.stdout.write(`RAH_NATIVE_CODEX_BROWSER_READY args=${process.argv.slice(2).join('|')}\\r\\n`);",
                "process.stdout.write(`Session: ${providerSessionId}\\r\\n`);",
                "function reportResize() {",
                "  process.stdout.write(`RAH_NATIVE_CODEX_BROWSER_RESIZE:${process.stdout.columns || 0}x${process.stdout.rows || 0}\\r\\n`);",
                "}",
                "process.stdout.on('resize', reportResize);",
                "setTimeout(reportResize, 50);",
                "process.stdin.setEncoding('utf8');",
                "if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);",
                "process.stdin.resume();",
                "let buffer = '';",
                "let turnIndex = 0;",
                "let pendingStopTurnId = null;",
                "function handleInterrupt() {",
                "  if (pendingStopTurnId) {",
                "    append({ timestamp: timestamp(1), type: 'event_msg', payload: { type: 'task_complete', turn_id: pendingStopTurnId } });",
                "    pendingStopTurnId = null;",
                "  }",
                "  process.stdout.write('RAH_NATIVE_CODEX_BROWSER_INTERRUPTED\\r\\n');",
                "  process.stdout.write('› ');",
                "}",
                "process.on('SIGINT', handleInterrupt);",
                "process.stdin.on('data', (chunk) => {",
                "  if (chunk.includes('\\u0003')) {",
                "    chunk = chunk.split('\\u0003').join('');",
                "    handleInterrupt();",
                "  }",
                "  if (pendingStopTurnId && chunk.includes('\\u001b')) {",
                "    chunk = chunk.split('\\u001b').join('');",
                "    handleInterrupt();",
                "  }",
                "  buffer += chunk;",
                "  const parts = buffer.split(/\\r|\\n/);",
                "  buffer = parts.pop() ?? '';",
                "  for (const raw of parts) {",
                "    const text = raw.trim();",
                "    if (!text) continue;",
                "    if (text === 'exit') {",
                "      process.stdout.write('RAH_NATIVE_CODEX_BROWSER_EXITING\\r\\n');",
                "      process.exit(0);",
                "    }",
                "    turnIndex += 1;",
                "    const turnId = `native-browser-turn-${turnIndex}`;",
                "    const answer = text.includes('RAH foreground resume prompt') ? 'RAH_NATIVE_CODEX_BROWSER_FOREGROUND_ANSWER' : text.includes('rah cli codex browser native') ? 'RAH_NATIVE_CODEX_BROWSER_CLI_ANSWER' : text.includes('BLOCKED_WHILE_TUI_PROMPT_DIRTY_TWO') ? 'RAH_NATIVE_CODEX_BROWSER_DIRTY_QUEUE_TWO' : text.includes('BLOCKED_WHILE_TUI_PROMPT_DIRTY') ? 'RAH_NATIVE_CODEX_BROWSER_DIRTY_QUEUE_ONE' : `RAH_NATIVE_CODEX_BROWSER_MIRROR_${turnIndex}`;",
                "    process.stdout.write(`RAH_NATIVE_CODEX_BROWSER_INPUT:${text}\\r\\n`);",
                "    append({ timestamp: timestamp(1), type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } });",
                "    append({ timestamp: timestamp(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });",
                "    if (text.includes('STOP_NATIVE_BROWSER')) {",
                "      pendingStopTurnId = turnId;",
                "      continue;",
                "    }",
                "    append({ timestamp: timestamp(3), type: 'event_msg', payload: { type: 'agent_message', message: answer } });",
                "    append({ timestamp: timestamp(4), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] } });",
                "    append({ timestamp: timestamp(5), type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } });",
                "    process.stdout.write(`RAH_NATIVE_CODEX_BROWSER_ANSWER:${answer}\\r\\n`);",
                "    process.stdout.write('› ');",
                "  }",
                "});",
                "setInterval(() => undefined, 1000);",
                "",
            ]
        ),
        encoding="utf-8",
    )
    path.chmod(0o755)


def write_long_codex_history(
    codex_home: pathlib.Path,
    workspace: pathlib.Path,
    provider_session_id: str,
    turns: int = 180,
) -> pathlib.Path:
    rollout_dir = codex_home / "sessions" / "2026" / "05" / "10"
    rollout_dir.mkdir(parents=True, exist_ok=True)
    rollout_path = rollout_dir / f"rollout-2026-05-10T00-00-00-{provider_session_id}.jsonl"

    def ts(index: int) -> str:
        minute = index // 60
        second = index % 60
        return f"2026-05-10T00:{minute:02d}:{second:02d}.000Z"

    rows: list[dict[str, Any]] = [
        {
            "timestamp": ts(0),
            "type": "session_meta",
            "payload": {
                "id": provider_session_id,
                "cwd": str(workspace),
                "timestamp": ts(0),
            },
        }
    ]
    event_index = 1
    for turn in range(1, turns + 1):
        user_text = f"HISTORY_PAGING_USER_{turn:03d}"
        assistant_text = f"HISTORY_PAGING_ASSISTANT_{turn:03d}"
        turn_id = f"history-paging-turn-{turn:03d}"
        rows.extend(
            [
                {
                    "timestamp": ts(event_index),
                    "type": "event_msg",
                    "payload": {"type": "task_started", "turn_id": turn_id},
                },
                {
                    "timestamp": ts(event_index + 1),
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": user_text}],
                    },
                },
                {
                    "timestamp": ts(event_index + 2),
                    "type": "event_msg",
                    "payload": {"type": "agent_message", "message": assistant_text},
                },
                {
                    "timestamp": ts(event_index + 3),
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": assistant_text}],
                    },
                },
                {
                    "timestamp": ts(event_index + 4),
                    "type": "event_msg",
                    "payload": {"type": "task_complete", "turn_id": turn_id},
                },
            ]
        )
        event_index += 5
    rollout_path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
        encoding="utf-8",
    )
    return rollout_path


def start_daemon(env: dict[str, str], port: int) -> subprocess.Popen[str]:
    proc = subprocess.Popen(
        ["node", "--import", "tsx", "packages/runtime-daemon/src/main.ts"],
        cwd=ROOT_DIR,
        env={**os.environ, **env, "RAH_PORT": str(port)},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    started = time.time()
    stdout = ""
    while time.time() - started < 20:
        if proc.poll() is not None:
            stderr = proc.stderr.read() if proc.stderr else ""
            raise RuntimeError(f"daemon exited early: stdout={stdout} stderr={stderr}")
        if proc.stdout is not None:
            line = proc.stdout.readline()
            if line:
                stdout += line
                if f"http://127.0.0.1:{port}" in line:
                    return proc
        time.sleep(0.05)
    raise TimeoutError(f"daemon did not start on port {port}; stdout={stdout}")


def wait_for_session_provider_id(
    base_url: str,
    session_id: str,
    provider_session_id: str | None,
) -> str:
    started = time.time()
    last_provider_session_id: str | None = None
    while time.time() - started < 15:
        summary = request_json(base_url, f"/api/sessions/{session_id}")["session"]
        value = summary["session"].get("providerSessionId")
        last_provider_session_id = str(value) if value else None
        if last_provider_session_id and (
            provider_session_id is None or last_provider_session_id == provider_session_id
        ):
            return last_provider_session_id
        time.sleep(0.2)
    if provider_session_id is None:
        raise AssertionError("native Codex providerSessionId did not bind")
    raise AssertionError(
        f"native Codex providerSessionId did not bind to {provider_session_id!r}; "
        f"last={last_provider_session_id!r}"
    )


def start_codex_browser_session(
    base_url: str,
    workspace: pathlib.Path,
    connection_id: str,
    title: str,
) -> tuple[str, str]:
    started = request_json(
        base_url,
        "/api/sessions/start",
        {
            "provider": "codex",
            "cwd": str(workspace),
            "liveBackend": "native_tui",
            "title": title,
            "model": "gpt-native-browser",
            "modeId": "never/danger-full-access",
            "attach": {
                "client": {
                    "id": "web-user",
                    "kind": "web",
                    "connectionId": connection_id,
                },
                "mode": "interactive",
                "claimControl": True,
            },
        },
    )["session"]
    session_id = str(started["session"]["id"])
    return session_id, wait_for_session_provider_id(base_url, session_id, None)


def session_exists(base_url: str, session_id: str) -> bool:
    try:
        request_json(base_url, f"/api/sessions/{session_id}")
        return True
    except RuntimeError as exc:
        if "HTTP 404" in str(exc):
            return False
        raise


def wait_for_session_absent(base_url: str, session_id: str, timeout_s: int = 20) -> None:
    started = time.time()
    while time.time() - started < timeout_s:
        if not session_exists(base_url, session_id):
            return
        time.sleep(0.2)
    raise AssertionError(f"session {session_id} still exists after {timeout_s}s")


def wait_for_live_session_absent(base_url: str, session_id: str, timeout_s: int = 20) -> None:
    started = time.time()
    while time.time() - started < timeout_s:
        if session_id not in live_session_ids(base_url):
            return
        time.sleep(0.2)
    raise AssertionError(f"session {session_id} still appears in live sessions")


def assert_session_not_in_pty_stats(base_url: str, session_id: str) -> None:
    stats = request_json(base_url, "/api/pty/stats")
    sessions = stats.get("sessions", [])
    if any(str(entry.get("sessionId")) == session_id for entry in sessions):
        raise AssertionError(f"session {session_id} still appears in PTY stats: {sessions}")


def wait_for_pty_status(
    base_url: str,
    session_id: str,
    expected: str,
    timeout_s: int = 20,
) -> None:
    started = time.time()
    last_sessions: list[dict[str, Any]] = []
    while time.time() - started < timeout_s:
        stats = request_json(base_url, "/api/pty/stats")
        last_sessions = stats.get("sessions", [])
        for entry in last_sessions:
            if str(entry.get("sessionId")) == session_id and entry.get("status") == expected:
                return
        time.sleep(0.2)
    raise AssertionError(
        f"PTY session {session_id} status did not become {expected!r}; last={last_sessions}"
    )


def wait_for_session_not_running(
    base_url: str,
    session_id: str,
    timeout_s: int = 20,
) -> None:
    started = time.time()
    last_session: dict[str, Any] | None = None
    while time.time() - started < timeout_s:
        last_session = request_json(base_url, f"/api/sessions/{session_id}")["session"]["session"]
        if last_session.get("runtimeState") != "running":
            return
        time.sleep(0.2)
    raise AssertionError(f"session {session_id} stayed running after TUI exit: {last_session}")


def wait_for_stored_history_ref(
    base_url: str,
    provider_session_id: str,
    timeout_s: int = 20,
) -> None:
    started = time.time()
    last_response: dict[str, Any] = {}
    while time.time() - started < timeout_s:
        response = request_json(base_url, "/api/sessions")
        last_response = response
        candidates = [
            *response.get("storedSessions", []),
            *response.get("recentSessions", []),
        ]
        if any(
            entry.get("provider") == "codex"
            and str(entry.get("providerSessionId")) == provider_session_id
            for entry in candidates
        ):
            return
        time.sleep(0.2)
    raise AssertionError(
        f"Codex provider history {provider_session_id!r} was not retained; "
        f"last={json.dumps(last_response, ensure_ascii=False)[:2000]}"
    )


def exercise_codex_tui_exit(
    page,
    base_url: str,
    workspace: pathlib.Path,
    artifact_dir: pathlib.Path,
) -> None:
    session_id, _provider_session_id = start_codex_browser_session(
        base_url,
        workspace,
        "native-codex-browser-tui-exit-smoke",
        "Codex TUI exit smoke",
    )
    try:
        page.reload(wait_until="domcontentloaded")
        open_live_session(page, session_id)
        page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
        panel = page.locator(".terminal-panel").last
        expect(panel).to_be_visible(timeout=10_000)
        wait_for_terminal_text(panel, "RAH_NATIVE_CODEX_BROWSER_READY")
        terminal_id = session_native_terminal_id(base_url, session_id)
        send_pty_input(base_url, terminal_id, "web-user", "exit\r")
        wait_for_pty_status(base_url, session_id, "exited")
        wait_for_session_not_running(base_url, session_id)
        time.sleep(0.5)
        wait_for_pty_status(base_url, session_id, "exited", timeout_s=2)
        page.reload(wait_until="domcontentloaded")
        save_browser_screenshot(page, artifact_dir, "codex-tui-exit-live-cleanup")
    finally:
        close_session_quietly(base_url, session_id)


def exercise_codex_archive(
    page,
    base_url: str,
    workspace: pathlib.Path,
    artifact_dir: pathlib.Path,
) -> None:
    session_id, provider_session_id = start_codex_browser_session(
        base_url,
        workspace,
        "native-codex-browser-archive-smoke",
        "Codex archive smoke",
    )
    try:
        page.reload(wait_until="domcontentloaded")
        open_live_session(page, session_id)
        page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
        panel = page.locator(".terminal-panel").last
        expect(panel).to_be_visible(timeout=10_000)
        wait_for_terminal_text(panel, "RAH_NATIVE_CODEX_BROWSER_READY")
        page.get_by_role("button", name="Chat", exact=True).click(timeout=30_000)
        page.locator('button[title="Archive this live session"]:visible').first.click(timeout=30_000)
        page.get_by_role("dialog").filter(has_text="Archive session?").get_by_role(
            "button",
            name="Archive",
            exact=True,
        ).click(timeout=30_000)
        wait_for_session_absent(base_url, session_id)
        wait_for_live_session_absent(base_url, session_id)
        assert_session_not_in_pty_stats(base_url, session_id)
        wait_for_stored_history_ref(base_url, provider_session_id)
        save_browser_screenshot(page, artifact_dir, "codex-archive-live-cleanup-history-retained")
    finally:
        close_session_quietly(base_url, session_id)


def exercise_codex_history_paging(
    page,
    base_url: str,
    provider_session_id: str,
    artifact_dir: pathlib.Path,
) -> None:
    page.reload(wait_until="domcontentloaded")
    page.locator('button[aria-label="Sessions"]:visible').first.click(timeout=30_000)
    page.get_by_role("button", name="All", exact=True).click(timeout=30_000)
    page.locator('input[placeholder*="Search"]:visible').first.fill(provider_session_id)
    page.locator(
        f'button[data-provider-session-id="{provider_session_id}"]:visible',
    ).first.click(timeout=30_000)
    chat_button = page.get_by_role("button", name="Chat", exact=True)
    if chat_button.count() > 0:
        chat_button.click(timeout=30_000)
    latest_marker = "HISTORY_PAGING_ASSISTANT_180"
    earliest_marker = "HISTORY_PAGING_USER_001"
    scroll_container = page.locator(
        '[data-testid="chat-thread-scroll-container"], .custom-scrollbar',
    ).last
    expect(scroll_container).to_be_visible(timeout=10_000)
    expect(scroll_container.get_by_text(latest_marker, exact=True)).to_be_visible(timeout=20_000)
    if earliest_marker in scroll_container.inner_text(timeout=10_000):
        raise AssertionError("history paging loaded the oldest marker before scrolling up")
    element = scroll_container.element_handle(timeout=10_000)
    if element is None:
        raise AssertionError("chat scroll container element was not available")
    scroll_container.evaluate(
        """(node) => {
          node.scrollTop = 0;
          node.dispatchEvent(new Event('scroll', { bubbles: true }));
        }"""
    )
    page.wait_for_function(
        """(node) => node.scrollTop > 80""",
        arg=element,
        timeout=20_000,
    )
    preserved_scroll_top = scroll_container.evaluate("(node) => node.scrollTop")
    if preserved_scroll_top <= 80:
        raise AssertionError(
            f"older-history prepend did not preserve scroll anchor; scrollTop={preserved_scroll_top}"
        )
    found_earliest = False
    for _ in range(8):
        scroll_container.evaluate(
            """(node) => {
              node.scrollTop = 0;
              node.dispatchEvent(new Event('scroll', { bubbles: true }));
            }"""
        )
        started = time.time()
        while time.time() - started < 5:
            if earliest_marker in scroll_container.inner_text(timeout=5_000):
                found_earliest = True
                break
            page.wait_for_timeout(200)
        if found_earliest:
            break
    if not found_earliest:
        raise AssertionError(f"older-history marker {earliest_marker!r} did not render in chat")
    save_browser_screenshot(page, artifact_dir, "codex-history-paging-older-anchor")


def exercise_missing_cwd_history(
    page,
    base_url: str,
    provider_session_id: str,
    missing_workspace: pathlib.Path,
    artifact_dir: pathlib.Path,
) -> None:
    if missing_workspace.exists():
        raise AssertionError(f"missing cwd fixture unexpectedly exists: {missing_workspace}")

    page.reload(wait_until="domcontentloaded")
    page.locator('button[aria-label="Sessions"]:visible').first.click(timeout=30_000)
    page.get_by_role("button", name="All", exact=True).click(timeout=30_000)
    page.locator('input[placeholder*="Search"]:visible').first.fill(provider_session_id)
    page.locator(
        f'button[data-provider-session-id="{provider_session_id}"]:visible',
    ).first.click(timeout=30_000)
    chat_button = page.get_by_role("button", name="Chat", exact=True)
    if chat_button.count() > 0:
        chat_button.click(timeout=30_000)

    expect(page.get_by_text("HISTORY_PAGING_ASSISTANT_003", exact=True)).to_be_visible(
        timeout=20_000,
    )
    expect(page.get_by_role("dialog").filter(has_text="Workspace is missing")).to_have_count(0)

    page.get_by_role("button", name="Claim control", exact=True).last.click(timeout=30_000)
    dialog = page.get_by_role("dialog").filter(has_text="Workspace is missing")
    expect(dialog).to_be_visible(timeout=10_000)
    expect(dialog.get_by_text("Create this workspace before starting the session?")).to_be_visible(
        timeout=10_000,
    )
    expect(dialog.get_by_text(str(missing_workspace), exact=True)).to_be_visible(timeout=10_000)
    expect(dialog.get_by_role("button", name="Create workspace", exact=True)).to_be_visible(
        timeout=10_000,
    )
    dialog.get_by_role("button", name="Cancel", exact=True).click(timeout=10_000)
    expect(dialog).to_be_hidden(timeout=10_000)
    if missing_workspace.exists():
        raise AssertionError(f"claim-cancel created missing cwd unexpectedly: {missing_workspace}")
    save_browser_screenshot(page, artifact_dir, "codex-missing-cwd-history-claim-prompt")


def wait_for_terminal_text(panel, needle: str, timeout_s: int = 15) -> None:
    started = time.time()
    last = ""
    while time.time() - started < timeout_s:
        last = panel.inner_text()
        if terminal_text_contains(last, needle):
            return
        panel.page.wait_for_timeout(200)
    raise AssertionError(f"terminal did not contain {needle!r}; tail={last[-1200:]}")


def terminal_text_contains(text: str, needle: str) -> bool:
    return (
        needle in text
        or needle in text.replace("\n", "")
        or re.sub(r"\s+", "", needle) in re.sub(r"\s+", "", text)
    )


def terminal_text_count(text: str, needle: str) -> int:
    # xterm innerText includes visual soft wraps. Narrow mobile panes can split
    # stable provider markers across lines, so count both raw and de-wrapped text.
    return max(
        text.count(needle),
        text.replace("\n", "").count(needle),
        re.sub(r"\s+", "", text).count(re.sub(r"\s+", "", needle)),
    )


def assert_page_text_absent(page, needle: str) -> None:
    text = page.locator("body").inner_text(timeout=5_000)
    if needle in text:
        raise AssertionError(f"page unexpectedly contained {needle!r}; tail={text[-1600:]}")


def assert_page_text_order(page, *needles: str) -> None:
    text = page.locator("body").inner_text(timeout=10_000)
    cursor = -1
    for needle in needles:
        index = text.find(needle, cursor + 1)
        if index < 0:
            raise AssertionError(
                f"page did not contain {needle!r} after offset {cursor}; tail={text[-1600:]}"
            )
        cursor = index


def page_text_occurrences(page, needle: str) -> int:
    return page.locator("body").inner_text(timeout=10_000).count(needle)


def wait_for_page_text_occurrences(page, needle: str, expected: int, timeout_s: int = 15) -> None:
    started = time.time()
    last_count = 0
    while time.time() - started < timeout_s:
        last_count = page_text_occurrences(page, needle)
        if last_count == expected:
            return
        page.wait_for_timeout(200)
    raise AssertionError(
        f"page text {needle!r} count did not become {expected}; last={last_count}"
    )


def wait_for_page_text_at_least(page, needle: str, minimum: int, timeout_s: int = 15) -> None:
    started = time.time()
    last_count = 0
    while time.time() - started < timeout_s:
        last_count = page_text_occurrences(page, needle)
        if last_count >= minimum:
            return
        page.wait_for_timeout(200)
    raise AssertionError(
        f"page text {needle!r} count did not reach {minimum}; last={last_count}"
    )


def chat_user_message_occurrences(page, needle: str) -> int:
    return page.get_by_test_id("chat-user-message").filter(has_text=needle).count()


def wait_for_chat_user_message_occurrences(page, needle: str, expected: int, timeout_s: int = 15) -> None:
    started = time.time()
    last_count = 0
    while time.time() - started < timeout_s:
        last_count = chat_user_message_occurrences(page, needle)
        if last_count == expected:
            return
        page.wait_for_timeout(200)
    raise AssertionError(
        f"chat user message {needle!r} count did not become {expected}; last={last_count}"
    )


def count_terminal_text(panel, needle: str) -> int:
    return terminal_text_count(panel.inner_text(), needle)


def wait_for_terminal_text_count(panel, needle: str, minimum: int, timeout_s: int = 15) -> None:
    started = time.time()
    last = ""
    while time.time() - started < timeout_s:
        last = panel.inner_text()
        if terminal_text_count(last, needle) >= minimum:
            return
        panel.page.wait_for_timeout(200)
    raise AssertionError(
        f"terminal did not contain {needle!r} at least {minimum} times; "
        f"count={terminal_text_count(last, needle)} tail={last[-1200:]}"
    )


def count_session_history_timeline_text(
    base_url: str,
    session_id: str,
    kind: str,
    text: str,
) -> tuple[int, list[dict[str, Any]]]:
    page = request_json(base_url, f"/api/sessions/{session_id}/history?limit=120")
    matches: list[dict[str, Any]] = []
    for event in page.get("events", []):
        if (
            event.get("type") == "timeline.item.added"
            and event.get("payload", {}).get("item", {}).get("kind") == kind
            and event.get("payload", {}).get("item", {}).get("text") == text
        ):
            matches.append(
                {
                    "id": event.get("id"),
                    "ts": event.get("ts"),
                    "turnId": event.get("turnId"),
                    "identity": event.get("payload", {}).get("identity"),
                    "source": event.get("source"),
                }
            )
    return len(matches), matches


def wait_for_session_history_timeline_text(
    base_url: str,
    session_id: str,
    kind: str,
    text: str,
    timeout_s: int = 20,
) -> None:
    started = time.time()
    last_matches: list[dict[str, Any]] = []
    while time.time() - started < timeout_s:
        count, matches = count_session_history_timeline_text(base_url, session_id, kind, text)
        last_matches = matches
        if count > 0:
            return
        time.sleep(0.2)
    raise AssertionError(
        f"session history did not contain {kind} text {text!r}; matches={last_matches}"
    )


def wait_for_session_history_timeline_text_count(
    base_url: str,
    session_id: str,
    kind: str,
    text: str,
    expected: int,
    timeout_s: int = 20,
) -> None:
    started = time.time()
    last_matches: list[dict[str, Any]] = []
    last_count = 0
    while time.time() - started < timeout_s:
        last_count, last_matches = count_session_history_timeline_text(
            base_url,
            session_id,
            kind,
            text,
        )
        if last_count == expected:
            return
        time.sleep(0.2)
    raise AssertionError(
        f"session history {kind} text {text!r} count did not become {expected}; "
        f"last={last_count} matches={last_matches}"
    )


def assert_session_idle(base_url: str, session_id: str, timeout_s: int = 15) -> None:
    started = time.time()
    last_session: dict[str, Any] | None = None
    while time.time() - started < timeout_s:
        last_session = request_json(base_url, f"/api/sessions/{session_id}")["session"]["session"]
        if last_session.get("runtimeState") == "idle":
            return
        time.sleep(0.2)
    raise AssertionError(f"session did not return to idle: {last_session}")


def session_native_terminal_id(base_url: str, session_id: str) -> str:
    session = request_json(base_url, f"/api/sessions/{session_id}")["session"]["session"]
    terminal_id = session.get("nativeTui", {}).get("terminalId")
    if not terminal_id:
        raise AssertionError(f"native session {session_id} did not expose a terminal id")
    return str(terminal_id)


def session_provider_session_id(base_url: str, session_id: str) -> str:
    session = request_json(base_url, f"/api/sessions/{session_id}")["session"]["session"]
    value = session.get("providerSessionId")
    if not value:
        raise AssertionError(f"session {session_id} did not expose providerSessionId")
    return str(value)


def wait_for_native_prompt_state(
    base_url: str,
    session_id: str,
    expected: str,
    timeout_s: int = 10,
) -> None:
    started = time.time()
    last_state: str | None = None
    while time.time() - started < timeout_s:
        summary = request_json(base_url, f"/api/sessions/{session_id}")
        native_tui = summary.get("session", {}).get("session", {}).get("nativeTui")
        if isinstance(native_tui, dict):
            last_state = native_tui.get("promptState")
            if last_state == expected:
                return
        time.sleep(0.2)
    raise AssertionError(f"native TUI prompt state did not become {expected!r}; last={last_state!r}")


def send_pty_input(base_url: str, terminal_id: str, client_id: str, data: str) -> None:
    ws_url = f"{base_url.replace('http', 'ws')}/api/pty/{terminal_id}"
    script = """
const WebSocket = require('ws');
const [url, terminalId, clientId, data] = process.argv.slice(1);
const socket = new WebSocket(url);
const timeout = setTimeout(() => {
  console.error('timed out sending PTY input');
  process.exit(2);
}, 5000);
socket.on('open', () => {
  socket.send(JSON.stringify({ type: 'pty.input', sessionId: terminalId, clientId, data }));
  setTimeout(() => socket.close(), 100);
});
socket.on('close', () => {
  clearTimeout(timeout);
  process.exit(0);
});
socket.on('error', (error) => {
  clearTimeout(timeout);
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
"""
    subprocess.run(
        ["node", "-e", script, ws_url, terminal_id, client_id, data],
        cwd=ROOT_DIR,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def chat_composer(page):
    return page.locator('textarea[aria-label="Message composer"]:visible').last


def fill_and_submit_chat_composer(page, text: str) -> None:
    composer = chat_composer(page)
    expect(composer).to_be_visible(timeout=10_000)
    composer.click()
    composer.press("Meta+A" if sys.platform == "darwin" else "Control+A")
    composer.press("Backspace")
    if composer.input_value() != "":
        composer.fill("")
    expect(composer).to_have_value("", timeout=5_000)
    composer.type(text)
    expect(composer).to_have_value(text, timeout=5_000)
    composer.press("Enter")


def print_browser_preflight_error(exc: Exception) -> int:
    print(
        json.dumps(
            {
                "ok": False,
                "error": str(exc),
                "traceback": traceback.format_exc(),
                "browser": selected_browser_name(),
                "headless": browser_headless(),
                "phase": "browser_preflight",
            },
            ensure_ascii=False,
            indent=2,
        ),
        file=os.sys.stderr,
    )
    return 1


def exercise_codex_cli_modes(
    page,
    base_url: str,
    workspace: pathlib.Path,
    provider_session_id: str,
    artifact_dir: pathlib.Path,
) -> dict[str, str]:
    cli_session_id: str | None = None
    cli_resume_session_id: str | None = None
    cli_proc: subprocess.Popen[str] | None = None
    resume_proc: subprocess.Popen[str] | None = None
    try:
        before = live_session_ids(base_url)
        cli_proc, cli_session_id = start_rah_codex_cli_session(base_url, workspace, before)
        cli_provider_session_id = wait_for_session_provider_id(base_url, cli_session_id, None)
        page.goto(base_url, wait_until="domcontentloaded")
        page.reload(wait_until="domcontentloaded")
        open_live_session(page, cli_session_id)
        page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
        panel = page.locator(".terminal-panel").last
        expect(panel).to_be_visible(timeout=10_000)
        wait_for_terminal_text(panel, "RAH_NATIVE_CODEX_BROWSER_READY")

        cli_prompt = "rah cli codex browser native"
        assert cli_proc.stdin is not None
        cli_proc.stdin.write(f"{cli_prompt}\n")
        cli_proc.stdin.flush()
        wait_for_terminal_text(panel, f"RAH_NATIVE_CODEX_BROWSER_INPUT:{cli_prompt}", timeout_s=20)
        cli_answer = "RAH_NATIVE_CODEX_BROWSER_CLI_ANSWER"
        wait_for_terminal_text(panel, f"RAH_NATIVE_CODEX_BROWSER_ANSWER:{cli_answer}", timeout_s=20)
        wait_for_session_history_timeline_text(
            base_url,
            cli_session_id,
            "assistant_message",
            cli_answer,
        )
        page.get_by_role("button", name="Chat", exact=True).click(timeout=30_000)
        expect(page.get_by_text(cli_answer, exact=True)).to_be_visible(timeout=20_000)
        assert_page_text_order(page, cli_prompt, cli_answer)
        assert_page_text_absent(page, "Unhandled provider event")
        assert_page_text_absent(page, "Loading older history")
        save_browser_screenshot(page, artifact_dir, "codex-rah-cli-chat-mirror")

        page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
        panel = page.locator(".terminal-panel").last
        expect(panel).to_be_visible(timeout=10_000)
        cli_stop_prompt = "STOP_NATIVE_BROWSER rah cli codex stop"
        interrupted_count = count_terminal_text(panel, "RAH_NATIVE_CODEX_BROWSER_INTERRUPTED")
        cli_proc.stdin.write(f"{cli_stop_prompt}\n")
        cli_proc.stdin.flush()
        wait_for_terminal_text(panel, f"RAH_NATIVE_CODEX_BROWSER_INPUT:{cli_stop_prompt}", timeout_s=20)
        cli_proc.stdin.write("\x1b")
        cli_proc.stdin.flush()
        wait_for_terminal_text_count(
            panel,
            "RAH_NATIVE_CODEX_BROWSER_INTERRUPTED",
            interrupted_count + 1,
        )
        assert_session_idle(base_url, cli_session_id)
        save_browser_screenshot(page, artifact_dir, "codex-rah-cli-terminal-stop")

        close_session_quietly(base_url, cli_session_id)
        terminate_cli_process(cli_proc)
        cli_proc = None

        before_resume = live_session_ids(base_url)
        resume_proc = spawn_rah_codex_cli(base_url, workspace, cli_provider_session_id)
        cli_resume_session_id = wait_for_new_live_session(base_url, before_resume)
        wait_for_session_provider_id(base_url, cli_resume_session_id, cli_provider_session_id)
        page.reload(wait_until="domcontentloaded")
        open_live_session(page, cli_resume_session_id)
        page.get_by_role("button", name="Chat", exact=True).click(timeout=30_000)
        expect(page.get_by_text(cli_answer, exact=True)).to_be_visible(timeout=20_000)
        answer_count, answer_matches = count_session_history_timeline_text(
            base_url,
            cli_resume_session_id,
            "assistant_message",
            cli_answer,
        )
        if answer_count != 1:
            raise AssertionError(
                "Codex rah cli resume duplicated CLI assistant answer; "
                f"count={answer_count} matches={answer_matches}"
            )
        assert_page_text_absent(page, "Unhandled provider event")
        assert_page_text_absent(page, "Loading older history")
        save_browser_screenshot(page, artifact_dir, "codex-rah-cli-resume-chat-history")

        close_session_quietly(base_url, cli_resume_session_id)
        terminate_cli_process(resume_proc)
        resume_proc = None
        return {
            "cliSessionId": cli_session_id,
            "cliResumeSessionId": cli_resume_session_id,
        }
    finally:
        terminate_cli_process(cli_proc)
        terminate_cli_process(resume_proc)
        close_session_quietly(base_url, cli_session_id)
        close_session_quietly(base_url, cli_resume_session_id)


def main() -> int:
    try:
        preflight_browser_runtime()
    except Exception as exc:
        return print_browser_preflight_error(exc)

    tmp_root = pathlib.Path(tempfile.mkdtemp(prefix="rah-native-codex-browser-"))
    workspace = tmp_root / "workspace"
    rah_home = tmp_root / "rah-home"
    codex_home = tmp_root / "codex-home"
    fake_codex = tmp_root / "fake-codex.js"
    provider_session_id = str(uuid.uuid4())
    long_history_provider_session_id = str(uuid.uuid4())
    missing_cwd_provider_session_id = str(uuid.uuid4())
    missing_workspace = tmp_root / "missing-workspace"
    title = "Native Codex Browser Smoke"
    prompt = "RAH native browser prompt"
    chat_prompt = "RAH native browser chat composer prompt"
    dirty_draft = "DIRTY_NATIVE_BROWSER_DRAFT"
    blocked_chat_prompt = "BLOCKED_WHILE_TUI_PROMPT_DIRTY"
    blocked_chat_prompt_two = "BLOCKED_WHILE_TUI_PROMPT_DIRTY_TWO"
    stop_prompt = "STOP_NATIVE_BROWSER prompt"
    foreground_resume_prompt = "RAH foreground resume prompt"
    mobile_prompt = "MOBILE_OK"
    mobile_composition_prompt = "中文_NATIVE_OK"
    expected_answer = "RAH_NATIVE_CODEX_BROWSER_MIRROR_1"
    expected_chat_answer = "RAH_NATIVE_CODEX_BROWSER_MIRROR_2"
    expected_queued_answer = "RAH_NATIVE_CODEX_BROWSER_DIRTY_QUEUE_ONE"
    expected_queued_answer_two = "RAH_NATIVE_CODEX_BROWSER_DIRTY_QUEUE_TWO"
    expected_foreground_answer = "RAH_NATIVE_CODEX_BROWSER_FOREGROUND_ANSWER"
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    artifact_dir = browser_artifact_dir("native-codex-browser")
    daemon: subprocess.Popen[str] | None = None
    session_id: str | None = None
    cli_modes_result: dict[str, str] | None = None

    try:
        workspace.mkdir(parents=True)
        (codex_home / "sessions").mkdir(parents=True)
        write_fake_codex(fake_codex)
        write_long_codex_history(codex_home, workspace, long_history_provider_session_id)
        write_long_codex_history(
            codex_home,
            missing_workspace,
            missing_cwd_provider_session_id,
            turns=3,
        )
        daemon = start_daemon(
            {
                "RAH_HOME": str(rah_home),
                "CODEX_HOME": str(codex_home),
                "RAH_CODEX_BINARY": str(fake_codex),
                "MOCK_CODEX_SESSION_ID": provider_session_id,
            },
            port,
        )

        request_json(base_url, "/api/workspaces/add", {"dir": str(workspace)})
        request_json(base_url, "/api/workspaces/select", {"dir": str(workspace)})
        started = request_json(
            base_url,
            "/api/sessions/start",
            {
                "provider": "codex",
                "cwd": str(workspace),
                "liveBackend": "native_tui",
                "title": title,
                "model": "gpt-native-browser",
                "modeId": "never/danger-full-access",
                "attach": {
                    "client": {
                        "id": "web-user",
                        "kind": "web",
                        "connectionId": "native-codex-browser-smoke",
                    },
                    "mode": "interactive",
                    "claimControl": True,
                },
            },
        )["session"]
        session_id = started["session"]["id"]
        provider_session_id = wait_for_session_provider_id(base_url, session_id, None)

        with sync_playwright() as playwright:
            browser = launch_browser(playwright)
            page = browser.new_page(viewport={"width": 1440, "height": 960})
            page.goto(base_url, wait_until="domcontentloaded")
            page.reload(wait_until="domcontentloaded")
            page.locator('button[aria-label="Sessions"]:visible').first.click(timeout=30_000)
            page.get_by_role("button", name="Live", exact=True).click(timeout=30_000)
            page.locator(f'button[data-session-id="{session_id}"]:visible').first.click(timeout=30_000)

            page.get_by_role("button", name="TUI", exact=True).click()
            panel = page.locator(".terminal-panel").last
            expect(panel).to_be_visible(timeout=10_000)
            wait_for_terminal_text(panel, "RAH_NATIVE_CODEX_BROWSER_READY")

            canvas = page.locator(".terminal-canvas").last
            canvas.click()
            page.keyboard.type(prompt)
            canvas.click()
            page.wait_for_timeout(200)
            page.keyboard.press("Enter")
            try:
                wait_for_terminal_text(panel, f"RAH_NATIVE_CODEX_BROWSER_INPUT:{prompt}", timeout_s=3)
            except AssertionError:
                page.keyboard.press("Control+M")
                wait_for_terminal_text(panel, f"RAH_NATIVE_CODEX_BROWSER_INPUT:{prompt}")

            page.get_by_role("button", name="Chat", exact=True).click()
            expect(page.get_by_text(expected_answer, exact=True)).to_be_visible(timeout=15_000)
            assert_page_text_order(page, prompt, expected_answer)
            assert_page_text_absent(page, "Unhandled provider event")
            assert_page_text_absent(page, "Loading older history")
            expect(page.get_by_role("button", name="Stop generating")).to_have_count(0, timeout=10_000)
            save_browser_screenshot(page, artifact_dir, "codex-chat-mirror")
            answer_count, answer_matches = count_session_history_timeline_text(
                base_url,
                session_id,
                "assistant_message",
                expected_answer,
            )
            if answer_count != 1:
                raise AssertionError(
                    "Codex rollout mirror duplicated agent_message plus assistant response_item; "
                    f"count={answer_count} matches={answer_matches}"
                )

            fill_and_submit_chat_composer(page, chat_prompt)
            page.get_by_role("button", name="TUI", exact=True).click()
            wait_for_terminal_text(panel, f"RAH_NATIVE_CODEX_BROWSER_INPUT:{chat_prompt}")
            save_browser_screenshot(page, artifact_dir, "codex-web-tui-after-chat-input")
            page.get_by_label("Close Web TUI client").click(timeout=10_000)
            expect(page.get_by_test_id("terminal-client-inactive-overlay")).to_be_visible(
                timeout=10_000
            )
            page.get_by_role("button", name="Activate TUI", exact=True).click(timeout=10_000)
            panel = page.locator(".terminal-panel").last
            expect(panel).to_be_visible(timeout=10_000)
            wait_for_terminal_text(panel, f"RAH_NATIVE_CODEX_BROWSER_INPUT:{chat_prompt}")
            save_browser_screenshot(page, artifact_dir, "codex-web-tui-after-reactivate")
            page.get_by_role("button", name="Chat", exact=True).click()
            expect(page.get_by_text(expected_chat_answer, exact=True)).to_be_visible(timeout=15_000)
            assert_page_text_order(page, chat_prompt, expected_chat_answer)
            assert_page_text_absent(page, "Unhandled provider event")
            assert_page_text_absent(page, "Loading older history")
            assert_session_idle(base_url, session_id)

            page.get_by_role("button", name="TUI", exact=True).click()
            terminal_id = session_native_terminal_id(base_url, session_id)
            send_pty_input(base_url, terminal_id, "web-user", dirty_draft)
            wait_for_native_prompt_state(base_url, session_id, "prompt_dirty")
            page.wait_for_timeout(300)
            page.get_by_role("button", name="Chat", exact=True).click()
            expect(page.get_by_text("Native TUI has an unsent local draft")).to_be_visible(
                timeout=10_000,
            )
            fill_and_submit_chat_composer(page, blocked_chat_prompt)
            fill_and_submit_chat_composer(page, blocked_chat_prompt_two)
            page.wait_for_timeout(1000)
            page.get_by_role("button", name="TUI", exact=True).click()
            panel = page.locator(".terminal-panel").last
            if blocked_chat_prompt in panel.inner_text():
                raise AssertionError("dirty TUI draft allowed Chat composer text to reach native TUI")
            interrupted_count = count_terminal_text(panel, "RAH_NATIVE_CODEX_BROWSER_INTERRUPTED")
            send_pty_input(base_url, terminal_id, "web-user", "\u0003")
            wait_for_terminal_text_count(
                panel,
                "RAH_NATIVE_CODEX_BROWSER_INTERRUPTED",
                interrupted_count + 1,
            )
            wait_for_terminal_text(panel, blocked_chat_prompt)
            wait_for_terminal_text(panel, expected_queued_answer)
            wait_for_terminal_text(panel, blocked_chat_prompt_two)
            wait_for_terminal_text(panel, expected_queued_answer_two)
            assert_session_idle(base_url, session_id)
            page.get_by_role("button", name="Chat", exact=True).click()
            expect(page.get_by_text(expected_queued_answer, exact=True)).to_be_visible(timeout=20_000)
            expect(page.get_by_text(expected_queued_answer_two, exact=True)).to_be_visible(timeout=20_000)
            assert_page_text_order(page, blocked_chat_prompt, blocked_chat_prompt_two)
            assert_page_text_order(page, expected_queued_answer, expected_queued_answer_two)
            save_browser_screenshot(page, artifact_dir, "codex-chat-dirty-queued-inputs")

            repeated_prompt = "REPEAT_NATIVE_BROWSER_PROMPT"
            fill_and_submit_chat_composer(page, repeated_prompt)
            wait_for_session_history_timeline_text_count(
                base_url,
                session_id,
                "user_message",
                repeated_prompt,
                1,
            )
            fill_and_submit_chat_composer(page, repeated_prompt)
            wait_for_session_history_timeline_text_count(
                base_url,
                session_id,
                "user_message",
                repeated_prompt,
                2,
            )
            wait_for_chat_user_message_occurrences(page, repeated_prompt, 2)

            page.get_by_role("button", name="Chat", exact=True).click()
            fill_and_submit_chat_composer(page, stop_prompt)
            wait_for_chat_user_message_occurrences(page, stop_prompt, 1)
            page.get_by_role("button", name="TUI", exact=True).click()
            wait_for_terminal_text(panel, f"RAH_NATIVE_CODEX_BROWSER_INPUT:{stop_prompt}")
            page.get_by_role("button", name="Chat", exact=True).click()
            interrupted_notice_count = page_text_occurrences(page, "Conversation interrupted")
            with page.expect_response(
                lambda response: response.url.endswith(f"/api/sessions/{session_id}/interrupt"),
                timeout=15_000,
            ) as interrupt_response_info:
                stop_button = page.get_by_role("button", name="Stop generating")
                stop_button.click(timeout=15_000)
                try:
                    stop_button.click(timeout=500)
                except Exception:
                    pass
            interrupt_response = interrupt_response_info.value
            if interrupt_response.status >= 400:
                raise AssertionError(
                    f"Codex interrupt request failed with HTTP {interrupt_response.status}: "
                    f"{interrupt_response.text()}"
                )
            page.get_by_role("button", name="TUI", exact=True).click()
            wait_for_terminal_text(panel, "RAH_NATIVE_CODEX_BROWSER_INTERRUPTED")
            assert_session_idle(base_url, session_id)
            wait_for_terminal_text(panel, "RAH_NATIVE_CODEX_BROWSER_READY")
            page.get_by_role("button", name="Chat", exact=True).click()
            wait_for_page_text_occurrences(
                page,
                "Conversation interrupted",
                interrupted_notice_count + 1,
            )
            assert_page_text_order(page, stop_prompt, "Conversation interrupted")
            expect(page.get_by_role("button", name="Stop generating")).to_have_count(0, timeout=10_000)

            page.reload(wait_until="domcontentloaded")
            page.locator('button[aria-label="Sessions"]:visible').first.click(timeout=30_000)
            page.get_by_role("button", name="Live", exact=True).click(timeout=30_000)
            page.locator(f'button[data-session-id="{session_id}"]:visible').first.click(timeout=30_000)
            page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
            panel = page.locator(".terminal-panel").last
            expect(panel).to_be_visible(timeout=10_000)
            wait_for_terminal_text(panel, f"RAH_NATIVE_CODEX_BROWSER_INPUT:{stop_prompt}")
            wait_for_terminal_text(panel, "RAH_NATIVE_CODEX_BROWSER_INTERRUPTED")
            save_browser_screenshot(page, artifact_dir, "codex-web-tui-after-reload")

            page.context.set_offline(True)
            request_json(
                base_url,
                f"/api/sessions/{session_id}/input",
                {"clientId": "web-user", "text": foreground_resume_prompt},
            )
            time.sleep(0.5)
            page.context.set_offline(False)
            page.evaluate(
                """() => {
                    window.dispatchEvent(new Event('online'));
                    window.dispatchEvent(new PageTransitionEvent('pageshow'));
                    window.dispatchEvent(new Event('focus'));
                    document.dispatchEvent(new Event('visibilitychange'));
                }"""
            )
            panel = page.locator(".terminal-panel").last
            expect(panel).to_be_visible(timeout=10_000)
            wait_for_terminal_text(
                panel,
                f"RAH_NATIVE_CODEX_BROWSER_INPUT:{foreground_resume_prompt}",
                timeout_s=20,
            )
            page.get_by_role("button", name="Chat", exact=True).click(timeout=30_000)
            expect(page.get_by_text(expected_foreground_answer, exact=True)).to_be_visible(
                timeout=20_000
            )
            page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)

            page.locator('button[aria-label="Open settings"]:visible').first.click(timeout=30_000)
            settings_dialog = page.get_by_role("dialog").filter(has_text="Settings")
            expect(settings_dialog).to_be_visible(timeout=10_000)
            page.get_by_role("button", name="Status", exact=True).click(timeout=10_000)
            expect(page.get_by_text("Terminal replay health", exact=True)).to_be_visible(
                timeout=20_000
            )
            expect(page.get_by_text("Sessions", exact=True)).to_be_visible(timeout=10_000)
            expect(page.get_by_text("Replay", exact=True)).to_be_visible(timeout=10_000)
            expect(page.get_by_text("Subscribers", exact=True)).to_be_visible(timeout=10_000)
            expect(page.get_by_text(terminal_id).first).to_be_visible(timeout=10_000)
            settings_dialog.get_by_role("button", name="Refresh", exact=True).click(timeout=10_000)
            expect(settings_dialog.get_by_text("since refresh").first).to_be_visible(
                timeout=20_000
            )
            expect(settings_dialog.get_by_text("Replay chunks").first).to_be_visible(
                timeout=10_000
            )
            settings_dialog.get_by_label("Close").click(timeout=10_000)
            expect(settings_dialog).to_be_hidden(timeout=10_000)

            if page.get_by_text("Canvas", exact=True).count() == 0:
                canvas_toggle = page.locator('button[aria-label="Open canvas"]:visible').first
                try:
                    canvas_toggle.click(timeout=30_000)
                except Exception as exc:
                    body_text = page.locator("body").inner_text(timeout=5_000)
                    pointer_debug = page.evaluate(
                        """() => {
                            const button = document.querySelector('button[aria-label="Open canvas"]');
                            const rect = button instanceof HTMLElement ? button.getBoundingClientRect() : null;
                            const x = rect ? rect.left + rect.width / 2 : 0;
                            const y = rect ? rect.top + rect.height / 2 : 0;
                            return {
                              bodyInline: document.body.style.pointerEvents,
                              bodyComputed: getComputedStyle(document.body).pointerEvents,
                              htmlInline: document.documentElement.style.pointerEvents,
                              htmlComputed: getComputedStyle(document.documentElement).pointerEvents,
                              buttonRect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
                              elementsAtButton: document.elementsFromPoint(x, y).slice(0, 6).map((element) => ({
                                tag: element.tagName,
                                aria: element.getAttribute('aria-label'),
                                title: element.getAttribute('title'),
                                cls: element.getAttribute('class'),
                                pointerEvents: getComputedStyle(element).pointerEvents,
                              })),
                            };
                        }"""
                    )
                    raise AssertionError(
                        f"could not open canvas after Settings health check; "
                        f"pointer={pointer_debug} body={body_text[-2000:]}"
                    ) from exc
            expect(page.get_by_text("Canvas", exact=True)).to_be_visible(timeout=10_000)
            page.get_by_role("button", name="TUI", exact=True).last.click(timeout=30_000)
            canvas_panel = page.locator(".terminal-panel").last
            expect(canvas_panel).to_be_visible(timeout=10_000)
            wait_for_terminal_text(canvas_panel, f"RAH_NATIVE_CODEX_BROWSER_INPUT:{stop_prompt}")
            wait_for_terminal_text(canvas_panel, "RAH_NATIVE_CODEX_BROWSER_RESIZE:")
            resize_count_before_layout = count_terminal_text(
                canvas_panel,
                "RAH_NATIVE_CODEX_BROWSER_RESIZE:",
            )
            for layout_title in [
                "Two panes stacked",
                "Three panes",
                "Four panes",
                "Two panes side by side",
            ]:
                page.locator(f'button[title="{layout_title}"]').click(timeout=10_000)
                canvas_panel = page.locator(".terminal-panel").last
                if canvas_panel.count() == 0:
                    page.get_by_role("button", name="TUI", exact=True).last.click(timeout=10_000)
                    canvas_panel = page.locator(".terminal-panel").last
                if canvas_panel.count() == 0:
                    body_text = page.locator("body").inner_text(timeout=5_000)
                    raise AssertionError(
                        f"canvas terminal missing after layout {layout_title!r}; "
                        f"body={body_text[-2000:]}"
                    )
                expect(canvas_panel).to_be_visible(timeout=10_000)
                wait_for_terminal_text(
                    canvas_panel,
                    "RAH_NATIVE_CODEX_BROWSER_INTERRUPTED",
                    timeout_s=5,
                )
            wait_for_terminal_text_count(
                page.locator(".terminal-panel").last,
                "RAH_NATIVE_CODEX_BROWSER_RESIZE:",
                resize_count_before_layout + 1,
            )
            page.locator('button[title="Hide canvas"]').click(timeout=10_000)

            mobile_assertions: list[str] = []
            if browser_supports_mobile_context():
                mobile_context = browser.new_context(
                    viewport={"width": 390, "height": 844},
                    is_mobile=True,
                    has_touch=True,
                )
                mobile_page = mobile_context.new_page()
                mobile_page.goto(base_url, wait_until="domcontentloaded")
                mobile_page.locator('button[aria-label="Open sidebar"]:visible').first.click(
                    timeout=30_000
                )
                mobile_page.locator('button[aria-label="Sessions"]:visible').first.click(timeout=30_000)
                mobile_page.get_by_role("button", name="Live", exact=True).click(timeout=30_000)
                mobile_page.locator(f'button[data-session-id="{session_id}"]:visible').first.click(
                    timeout=30_000
                )
                mobile_page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
                mobile_panel = mobile_page.locator(".terminal-panel").last
                expect(mobile_panel).to_be_visible(timeout=10_000)
                mobile_bridge = mobile_page.locator('[data-testid="terminal-ios-input-bridge"]').last
                expect(mobile_bridge).to_be_visible(timeout=10_000)
                mobile_canvas = mobile_page.locator(".terminal-canvas").last
                mobile_canvas.click()
                mobile_page.wait_for_timeout(250)
                focused_after_canvas_click = mobile_page.evaluate(
                    """() => {
                        const active = document.activeElement;
                        return active instanceof HTMLElement ? active.className : '';
                    }"""
                )
                if "terminal-ios-input" in str(focused_after_canvas_click):
                    raise AssertionError(
                        "mobile terminal canvas click should not focus the RAH input bridge; "
                        "only the bridge composer should open the keyboard, "
                        f"focused={focused_after_canvas_click!r}"
                    )
                mobile_bridge.locator("input").click()
                mobile_page.wait_for_timeout(250)
                focused_after_bridge_click = mobile_page.evaluate(
                    """() => {
                        const active = document.activeElement;
                        return active instanceof HTMLElement ? active.className : '';
                    }"""
                )
                if "terminal-ios-input" not in str(focused_after_bridge_click):
                    raise AssertionError(
                        "mobile RAH input bridge click should focus the bridge input, "
                        f"focused={focused_after_bridge_click!r}"
                    )
                for shortcut in [
                    "Ctrl-C",
                    "Esc",
                    "Tab",
                    "Arrow up",
                    "Arrow down",
                    "Arrow left",
                    "Arrow right",
                    "Enter",
                ]:
                    expect(mobile_bridge.get_by_role("button", name=shortcut, exact=True)).to_be_visible()
                interrupted_count = count_terminal_text(
                    mobile_panel,
                    "RAH_NATIVE_CODEX_BROWSER_INTERRUPTED",
                )
                mobile_bridge.get_by_role("button", name="Ctrl-C", exact=True).click()
                wait_for_terminal_text_count(
                    mobile_panel,
                    "RAH_NATIVE_CODEX_BROWSER_INTERRUPTED",
                    interrupted_count + 1,
                )
                mobile_bridge.locator("input").fill(mobile_prompt)
                mobile_bridge.get_by_role("button", name="Enter", exact=True).click()
                wait_for_terminal_text(
                    mobile_panel,
                    f"RAH_NATIVE_CODEX_BROWSER_INPUT:{mobile_prompt}",
                )
                mobile_page.evaluate(
                    """(value) => {
                        const input = document.querySelector('.terminal-ios-input');
                        if (!(input instanceof HTMLInputElement)) {
                          throw new Error('terminal ios bridge input not found');
                        }
                        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
                        input.value = value;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value }));
                    }""",
                    mobile_composition_prompt,
                )
                mobile_bridge.get_by_role("button", name="Enter", exact=True).click()
                wait_for_terminal_text(
                    mobile_panel,
                    f"RAH_NATIVE_CODEX_BROWSER_INPUT:{mobile_composition_prompt}",
                )
                save_browser_screenshot(mobile_page, artifact_dir, "codex-mobile-tui-bridge")

                try:
                    mobile_page.locator('button[aria-label="Open sidebar"]:visible').first.click(
                        timeout=2_000,
                    )
                except Exception:
                    pass
                mobile_page.locator('button[aria-label="Home"]:visible').first.click(timeout=30_000)
                expect(
                    mobile_page.get_by_text("What would you like to build?", exact=True),
                ).to_be_visible(timeout=10_000)
                expect(
                    mobile_page.locator('textarea[placeholder="Message…"]:visible').first,
                ).to_be_visible(timeout=10_000)
                composer_layout = mobile_page.evaluate(
                    """() => {
                        const viewportWidth = window.innerWidth;
                        const textarea = document.querySelector('textarea[placeholder="Message…"]');
                        if (!(textarea instanceof HTMLElement)) {
                          return { error: 'textarea missing' };
                        }
                        const textRect = textarea.getBoundingClientRect();
                        const buttons = [...document.querySelectorAll('button')]
                          .filter((element) => {
                            const rect = element.getBoundingClientRect();
                            if (rect.width <= 0 || rect.height <= 0) return false;
                            return rect.bottom >= textRect.top
                              && rect.top <= textRect.bottom + 24
                              && rect.right >= textRect.left - 16
                              && rect.left <= textRect.right + 16;
                          })
                          .map((element, index) => {
                            const rect = element.getBoundingClientRect();
                            return {
                              index,
                              label: element.getAttribute('aria-label')
                                || element.getAttribute('title')
                                || element.textContent?.trim()
                                || '',
                              left: rect.left,
                              right: rect.right,
                              top: rect.top,
                              bottom: rect.bottom,
                              width: rect.width,
                              height: rect.height,
                            };
                          });
                        const overlaps = [];
                        for (let i = 0; i < buttons.length; i += 1) {
                          for (let j = i + 1; j < buttons.length; j += 1) {
                            const a = buttons[i];
                            const b = buttons[j];
                            const horizontal = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
                            const vertical = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
                            if (horizontal > 2 && vertical > 2) {
                              overlaps.push([a.label, b.label, horizontal, vertical]);
                            }
                          }
                        }
                        return {
                          viewportWidth,
                          scrollWidth: document.documentElement.scrollWidth,
                          documentOverflowX: document.documentElement.scrollWidth > viewportWidth + 2,
                          textarea: {
                            left: textRect.left,
                            right: textRect.right,
                            top: textRect.top,
                            bottom: textRect.bottom,
                            width: textRect.width,
                          },
                          buttons,
                          overlaps,
                          startVisible: buttons.some((button) => button.label === 'Start session'),
                          minButtonHeight: buttons.length
                            ? Math.min(...buttons.map((button) => button.height))
                            : 0,
                        };
                    }""",
                )
                if composer_layout.get("error"):
                    raise AssertionError(f"mobile composer layout error: {composer_layout}")
                if composer_layout["documentOverflowX"]:
                    raise AssertionError(f"mobile composer caused horizontal overflow: {composer_layout}")
                if composer_layout["overlaps"]:
                    raise AssertionError(f"mobile composer controls overlap: {composer_layout}")
                if not composer_layout["startVisible"]:
                    raise AssertionError(f"mobile composer start button missing: {composer_layout}")
                if composer_layout["minButtonHeight"] < 30:
                    raise AssertionError(f"mobile composer controls are too small: {composer_layout}")
                if (
                    composer_layout["textarea"]["left"] < -1
                    or composer_layout["textarea"]["right"] > composer_layout["viewportWidth"] + 1
                ):
                    raise AssertionError(f"mobile composer textarea exceeds viewport: {composer_layout}")
                save_browser_screenshot(mobile_page, artifact_dir, "codex-mobile-new-session-composer")
                mobile_context.close()
                mobile_assertions = [
                    "mobile TUI input bridge sends shortcut keys, text input, and composition input",
                    "mobile TUI canvas click preserves terminal scrolling; the RAH input bridge owns keyboard focus",
                    "mobile new-session composer controls fit compact iPhone viewport without overflow or overlap",
                ]

            resume_provider_session_id = session_provider_session_id(base_url, session_id)
            close_session_quietly(base_url, session_id)
            session_id = None
            resumed = request_json(
                base_url,
                "/api/sessions/resume",
                {
                    "provider": "codex",
                    "providerSessionId": resume_provider_session_id,
                    "cwd": str(workspace),
                    "liveBackend": "native_tui",
                    "model": "gpt-native-browser",
                    "modeId": "never/danger-full-access",
                    "attach": {
                        "client": {
                            "id": "web-user",
                            "kind": "web",
                            "connectionId": "native-codex-browser-resume-smoke",
                        },
                        "mode": "interactive",
                        "claimControl": True,
                    },
                },
            )["session"]
            resume_session_id = resumed["session"]["id"]
            session_id = resume_session_id
            page.reload(wait_until="domcontentloaded")
            page.locator('button[aria-label="Sessions"]:visible').first.click(timeout=30_000)
            page.get_by_role("button", name="Live", exact=True).click(timeout=30_000)
            page.locator(f'button[data-session-id="{resume_session_id}"]:visible').first.click(timeout=30_000)
            page.get_by_role("button", name="Chat", exact=True).click(timeout=30_000)
            expect(page.get_by_text(expected_answer, exact=True)).to_be_visible(timeout=20_000)
            resume_answer_count, resume_answer_matches = count_session_history_timeline_text(
                base_url,
                resume_session_id,
                "assistant_message",
                expected_answer,
            )
            if resume_answer_count != 1:
                raise AssertionError(
                    "Codex resumed history duplicated assistant answer; "
                    f"count={resume_answer_count} matches={resume_answer_matches}"
                )
            assert_page_text_absent(page, "Unhandled provider event")
            save_browser_screenshot(page, artifact_dir, "codex-web-resume-chat-history")

            close_session_quietly(base_url, session_id)
            session_id = None
            if os.environ.get("RAH_NATIVE_CODEX_BROWSER_EXERCISE_CLI") == "1":
                cli_modes_result = exercise_codex_cli_modes(
                    page,
                    base_url,
                    workspace,
                    provider_session_id,
                    artifact_dir,
                )
            else:
                cli_modes_result = {
                    "skipped": (
                        "rah codex defaults to native_local_server and requires a real Codex "
                        "app-server; this fake native_tui browser smoke covers explicit "
                        "native_tui only. Use test:smoke:native-local-server for the default "
                        "rah codex provider-server path."
                    ),
                }
            exercise_codex_history_paging(
                page,
                base_url,
                long_history_provider_session_id,
                artifact_dir,
            )
            exercise_missing_cwd_history(
                page,
                base_url,
                missing_cwd_provider_session_id,
                missing_workspace,
                artifact_dir,
            )
            exercise_codex_tui_exit(page, base_url, workspace, artifact_dir)
            exercise_codex_archive(page, base_url, workspace, artifact_dir)

            browser.close()

        close_session_quietly(base_url, session_id)
        print(
            json.dumps(
                {
                    "ok": True,
                    "baseUrl": base_url,
                    "sessionId": session_id,
                    "providerSessionId": provider_session_id,
                    "browser": selected_browser_name(),
                    "headless": browser_headless(),
                    "caseIds": CASE_IDS,
                    "screenshots": SCREENSHOTS,
                    "cliResult": cli_modes_result,
                    "asserted": [
                        "Web can select native Codex live session",
                        "Chat/TUI toggle is rendered",
                        "xterm receives native TUI output",
                        "TUI input reaches daemon-owned provider process",
                        "Chat mirror renders provider history output",
                        "Chat renders provider user messages before assistant replies",
                        "Chat does not show loading-history or unhandled-provider-event noise for new live sessions",
                        "Chat mirror dedupes Codex agent_message plus assistant response_item",
                        "Chat composer input reaches daemon-owned native TUI",
                        "Web TUI close and activate restores native TUI replay",
                        "Chat composer queues while the native TUI prompt has an unsubmitted draft",
                        "Chat view warns when the native TUI prompt has an unsubmitted draft",
                        "Stop button sends provider-native interrupt to daemon-owned native TUI",
                        "Stop returns daemon-owned native TUI session to idle",
                        "Multiple queued Chat prompts drain in order after prompt clears",
                        "TUI replay survives page reload",
                        "Foreground recovery catches up native TUI and Chat mirror without reselection",
                        "Web resume opens Codex history without duplicating existing assistant messages",
                        "Stored Codex history loads the latest page first and preserves scroll anchor when older pages prepend",
                        "Missing-cwd history browsing does not prompt until Claim control",
                        "Explicit native_tui browser flow stays separate from rah codex native_local_server default",
                        "Settings Status shows PTY terminal replay health for native TUI sessions",
                        "Settings Status refresh shows PTY terminal replay deltas",
                        "Canvas panes render native TUI and preserve replay across layout changes",
                        "Canvas layout changes send PTY resize events to native TUI",
                        "TUI client exit marks PTY as exited and leaves the session not running",
                        "Archive closes the live session and PTY state while retaining provider history",
                        *mobile_assertions,
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": str(exc),
                    "traceback": traceback.format_exc(),
                    "baseUrl": base_url,
                    "providerSessionId": provider_session_id,
                    "browser": selected_browser_name(),
                    "headless": browser_headless(),
                    "screenshots": SCREENSHOTS,
                },
                ensure_ascii=False,
                indent=2,
            ),
            file=os.sys.stderr,
        )
        return 1
    finally:
        close_session_quietly(base_url, session_id)
        if daemon:
            terminate_process_tree(daemon)
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
