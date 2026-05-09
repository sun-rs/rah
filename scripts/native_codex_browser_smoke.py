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
import traceback
import uuid
from typing import Any
from urllib import error, request

from playwright.sync_api import expect, sync_playwright

from native_smoke_process import terminate_process_tree


ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent


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
                "const providerSessionId = process.env.MOCK_CODEX_SESSION_ID;",
                "const codexHome = process.env.CODEX_HOME;",
                "if (!providerSessionId || !codexHome) process.exit(2);",
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
                "    turnIndex += 1;",
                "    const turnId = `native-browser-turn-${turnIndex}`;",
                "    const answer = text.includes('RAH foreground resume prompt') ? 'RAH_NATIVE_CODEX_BROWSER_FOREGROUND_ANSWER' : `RAH_NATIVE_CODEX_BROWSER_MIRROR_${turnIndex}`;",
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


def wait_for_session_provider_id(base_url: str, session_id: str, provider_session_id: str) -> None:
    started = time.time()
    while time.time() - started < 15:
        summary = request_json(base_url, f"/api/sessions/{session_id}")["session"]
        if summary["session"].get("providerSessionId") == provider_session_id:
            return
        time.sleep(0.2)
    raise AssertionError("native Codex providerSessionId did not bind")


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
    return needle in text or needle in text.replace("\n", "")


def terminal_text_count(text: str, needle: str) -> int:
    # xterm innerText includes visual soft wraps. Narrow mobile panes can split
    # stable provider markers across lines, so count both raw and de-wrapped text.
    return max(text.count(needle), text.replace("\n", "").count(needle))


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
    title = "Native Codex Browser Smoke"
    prompt = "RAH native browser prompt"
    chat_prompt = "RAH native browser chat composer prompt"
    dirty_draft = "DIRTY_NATIVE_BROWSER_DRAFT"
    blocked_chat_prompt = "BLOCKED_WHILE_TUI_PROMPT_DIRTY"
    stop_prompt = "STOP_NATIVE_BROWSER prompt"
    foreground_resume_prompt = "RAH foreground resume prompt"
    mobile_prompt = "MOBILE_OK"
    mobile_composition_prompt = "中文_NATIVE_OK"
    expected_answer = "RAH_NATIVE_CODEX_BROWSER_MIRROR_1"
    expected_chat_answer = "RAH_NATIVE_CODEX_BROWSER_MIRROR_2"
    expected_queued_answer = "RAH_NATIVE_CODEX_BROWSER_MIRROR_3"
    expected_foreground_answer = "RAH_NATIVE_CODEX_BROWSER_FOREGROUND_ANSWER"
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    daemon: subprocess.Popen[str] | None = None
    session_id: str | None = None

    try:
        workspace.mkdir(parents=True)
        (codex_home / "sessions").mkdir(parents=True)
        write_fake_codex(fake_codex)
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
        wait_for_session_provider_id(base_url, session_id, provider_session_id)

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
            page.get_by_role("button", name="Chat", exact=True).click()
            expect(page.get_by_text(expected_chat_answer, exact=True)).to_be_visible(timeout=15_000)
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
            wait_for_terminal_text(
                panel,
                f"RAH_NATIVE_CODEX_BROWSER_INPUT:{blocked_chat_prompt}",
            )
            wait_for_terminal_text(panel, expected_queued_answer)
            assert_session_idle(base_url, session_id)

            page.get_by_role("button", name="Chat", exact=True).click()
            fill_and_submit_chat_composer(page, stop_prompt)
            page.get_by_role("button", name="TUI", exact=True).click()
            wait_for_terminal_text(panel, f"RAH_NATIVE_CODEX_BROWSER_INPUT:{stop_prompt}")
            page.get_by_role("button", name="Chat", exact=True).click()
            page.get_by_role("button", name="Stop generating").click(timeout=15_000)
            page.get_by_role("button", name="TUI", exact=True).click()
            wait_for_terminal_text(panel, "RAH_NATIVE_CODEX_BROWSER_INTERRUPTED")
            assert_session_idle(base_url, session_id)

            page.reload(wait_until="domcontentloaded")
            page.locator('button[aria-label="Sessions"]:visible').first.click(timeout=30_000)
            page.get_by_role("button", name="Live", exact=True).click(timeout=30_000)
            page.locator(f'button[data-session-id="{session_id}"]:visible').first.click(timeout=30_000)
            page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
            panel = page.locator(".terminal-panel").last
            expect(panel).to_be_visible(timeout=10_000)
            wait_for_terminal_text(panel, f"RAH_NATIVE_CODEX_BROWSER_INPUT:{stop_prompt}")
            wait_for_terminal_text(panel, "RAH_NATIVE_CODEX_BROWSER_INTERRUPTED")

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
            page.get_by_role("button", name="Version", exact=True).click(timeout=10_000)
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
                if "terminal-ios-input" not in str(focused_after_canvas_click):
                    raise AssertionError(
                        "mobile terminal canvas click should focus the RAH input bridge, "
                        f"focused={focused_after_canvas_click!r}"
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
                mobile_context.close()
                mobile_assertions = [
                    "mobile TUI input bridge sends shortcut keys, text input, and composition input",
                    "mobile TUI canvas click focuses the RAH input bridge instead of xterm hidden textarea",
                ]

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
                    "asserted": [
                        "Web can select native Codex live session",
                        "Chat/TUI toggle is rendered",
                        "xterm receives native TUI output",
                        "TUI input reaches daemon-owned provider process",
                        "Chat mirror renders provider history output",
                        "Chat mirror dedupes Codex agent_message plus assistant response_item",
                        "Chat composer input reaches daemon-owned native TUI",
                        "Chat composer queues while the native TUI prompt has an unsubmitted draft",
                        "Chat view warns when the native TUI prompt has an unsubmitted draft",
                        "Stop button sends Ctrl-C to daemon-owned native TUI",
                        "Stop returns daemon-owned native TUI session to idle",
                        "TUI replay survives page reload",
                        "Foreground recovery catches up native TUI and Chat mirror without reselection",
                        "Settings Version shows PTY terminal replay health for native TUI sessions",
                        "Settings Version refresh shows PTY terminal replay deltas",
                        "Canvas panes render native TUI and preserve replay across layout changes",
                        "Canvas layout changes send PTY resize events to native TUI",
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
