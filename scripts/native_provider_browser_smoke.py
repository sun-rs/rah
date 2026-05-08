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
from dataclasses import dataclass
from typing import Any
from urllib import request

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import expect, sync_playwright

from native_smoke_process import terminate_process_tree


ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent


def selected_browser_name() -> str:
    return os.environ.get("RAH_NATIVE_BROWSER", "chromium").strip().lower()


def browser_headless() -> bool:
    return os.environ.get("RAH_NATIVE_HEADLESS", "1") != "0"


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


@dataclass(frozen=True)
class ProviderConfig:
    provider: str
    env_name: str
    ready_marker: str
    input_marker: str
    interrupt_marker: str
    request: dict[str, Any]
    expected_arg_fragments: tuple[str, ...]
    expects_chat_mirror: bool = False
    expected_mirror_text: str | None = None


CONFIGS = (
    ProviderConfig(
        provider="claude",
        env_name="RAH_CLAUDE_BINARY",
        ready_marker="RAH_NATIVE_CLAUDE_BROWSER_READY",
        input_marker="RAH_NATIVE_CLAUDE_BROWSER_INPUT",
        interrupt_marker="RAH_NATIVE_CLAUDE_BROWSER_INTERRUPTED",
        request={
            "model": "opus",
            "optionValues": {"effort": "max"},
            "modeId": "bypassPermissions",
        },
        expected_arg_fragments=("--session-id|", "--model|opus", "--effort|max"),
        expects_chat_mirror=True,
        expected_mirror_text="Claude native browser answer",
    ),
    ProviderConfig(
        provider="opencode",
        env_name="RAH_OPENCODE_BINARY",
        ready_marker="RAH_NATIVE_OPENCODE_BROWSER_READY",
        input_marker="RAH_NATIVE_OPENCODE_BROWSER_INPUT",
        interrupt_marker="RAH_NATIVE_OPENCODE_BROWSER_INTERRUPTED",
        request={
            "model": "deepseek/deepseek-v4-pro",
            "optionValues": {"model_reasoning_variant": "high"},
            "modeId": "opencode/full-auto",
        },
        expected_arg_fragments=("--model|deepseek/deepseek-v4-pro",),
        expects_chat_mirror=True,
        expected_mirror_text="OpenCode native browser answer",
    ),
)

STARTED_SESSIONS: list[tuple[str, str]] = []


def request_json(base_url: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    if payload is None:
        req = request.Request(f"{base_url}{path}")
    else:
        req = request.Request(
            f"{base_url}{path}",
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
        )
    with request.urlopen(req, timeout=120) as response:
        body = response.read()
        return json.loads(body) if body else {}


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


def write_fake_provider(path: pathlib.Path, config: ProviderConfig) -> None:
    claude_history_setup = []
    if config.provider == "claude":
        claude_history_setup = [
            "setTimeout(() => {",
            "  const configDir = process.env.CLAUDE_CONFIG_DIR;",
            "  const sessionArgIndex = process.argv.indexOf('--session-id');",
            "  const sessionId = sessionArgIndex >= 0 ? process.argv[sessionArgIndex + 1] : undefined;",
            "  if (!configDir || !sessionId) return;",
            "  const fs = require('node:fs');",
            "  const path = require('node:path');",
            "  const projectId = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');",
            "  const projectDir = path.join(configDir, 'projects', projectId);",
            "  const now = new Date().toISOString();",
            "  fs.mkdirSync(projectDir, { recursive: true });",
            "  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [",
            "    JSON.stringify({ type: 'user', uuid: 'claude-native-browser-user', cwd: process.cwd(), sessionId, timestamp: now, message: { content: 'Claude native browser question' } }),",
            "    JSON.stringify({ type: 'assistant', uuid: 'claude-native-browser-assistant', cwd: process.cwd(), sessionId, timestamp: now, message: { content: [{ type: 'text', text: 'Claude native browser answer' }] } }),",
            "  ].join('\\n') + '\\n');",
            "}, 100);",
        ]
    opencode_history_setup = []
    if config.provider == "opencode":
        opencode_history_setup = [
            "setTimeout(() => {",
            "  const dataHome = process.env.XDG_DATA_HOME;",
            "  const sessionId = process.env.MOCK_OPENCODE_SESSION_ID;",
            "  if (!dataHome || !sessionId) return;",
            "  const fs = require('node:fs');",
            "  const path = require('node:path');",
            "  const { execFileSync } = require('node:child_process');",
            "  const sql = (value) => `'${String(value).replace(/'/g, `''`)}'`;",
            "  const db = path.join(dataHome, 'opencode', 'opencode.db');",
            "  fs.mkdirSync(path.dirname(db), { recursive: true });",
            "  const now = Date.now();",
            "  const writeDb = (attempt = 0) => {",
            "    try {",
            "      execFileSync('sqlite3', [db, `",
            "    pragma busy_timeout = 5000;",
            "    create table if not exists project (id text primary key, worktree text, name text, time_updated integer);",
            "    create table if not exists session (id text primary key, project_id text not null, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer);",
            "    create table if not exists message (id text primary key, session_id text, time_created integer, time_updated integer, data text);",
            "    create table if not exists part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);",
            "    insert or replace into project (id, worktree, name, time_updated) values ('project_native', ${sql(process.cwd())}, null, ${now});",
            "    insert or replace into session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived)",
            "      values (${sql(sessionId)}, 'project_native', null, ${sql(process.cwd())}, 'OpenCode native browser smoke', ${now}, ${now}, null);",
            "    insert or replace into message (id, session_id, time_created, time_updated, data)",
            "      values ('msg_user_native', ${sql(sessionId)}, ${now + 10}, ${now + 10}, ${sql(JSON.stringify({ role: 'user', time: { created: now + 10 } }))});",
            "    insert or replace into message (id, session_id, time_created, time_updated, data)",
            "      values ('msg_assistant_native', ${sql(sessionId)}, ${now + 20}, ${now + 30}, ${sql(JSON.stringify({ role: 'assistant', parentID: 'msg_user_native', finish: 'stop', time: { created: now + 20, completed: now + 30 }, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } }, cost: 0.0123 }))});",
            "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
            "      values ('part_user_native', 'msg_user_native', ${sql(sessionId)}, ${now + 11}, ${now + 11}, ${sql(JSON.stringify({ type: 'text', text: 'OpenCode native browser question' }))});",
            "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
            "      values ('part_01_reasoning_native', 'msg_assistant_native', ${sql(sessionId)}, ${now + 21}, ${now + 21}, ${sql(JSON.stringify({ type: 'reasoning', text: 'OpenCode native browser reasoning trace' }))});",
            "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
            "      values ('part_02_step_start_native', 'msg_assistant_native', ${sql(sessionId)}, ${now + 22}, ${now + 22}, ${sql(JSON.stringify({ type: 'step-start' }))});",
            "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
            "      values ('part_03_tool_native', 'msg_assistant_native', ${sql(sessionId)}, ${now + 23}, ${now + 24}, ${sql(JSON.stringify({ type: 'tool', callID: 'call_native_browser', tool: 'bash', state: { status: 'completed', input: { command: 'printf opencode-browser-tool' }, output: 'opencode browser tool output', title: 'OpenCode browser tool' } }))});",
            "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
            "      values ('part_04_assistant_native', 'msg_assistant_native', ${sql(sessionId)}, ${now + 25}, ${now + 26}, ${sql(JSON.stringify({ type: 'text', text: 'OpenCode native browser answer' }))});",
            "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
            "      values ('part_05_step_finish_native', 'msg_assistant_native', ${sql(sessionId)}, ${now + 27}, ${now + 30}, ${sql(JSON.stringify({ type: 'step-finish', reason: 'stop' }))});",
            "      `]);",
            "    } catch (error) {",
            "      if (attempt < 20) {",
            "        setTimeout(() => writeDb(attempt + 1), 100);",
            "        return;",
            "      }",
            "      throw error;",
            "    }",
            "  };",
            "  writeDb();",
            "}, 100);",
        ]
    path.write_text(
        "\n".join(
            [
                "#!/usr/bin/env node",
                f"process.stdout.write(`{config.ready_marker} args=${{process.argv.slice(2).join('|')}}\\r\\n`);",
                *claude_history_setup,
                *opencode_history_setup,
                "process.stdin.setEncoding('utf8');",
                "process.stdin.resume();",
                "let buffer = '';",
                f"function handleInterrupt() {{ process.stdout.write(`{config.interrupt_marker}\\r\\n`); }}",
                "process.on('SIGINT', handleInterrupt);",
                "process.stdin.on('data', (chunk) => {",
                "  if (chunk.includes('\\u0003')) {",
                "    chunk = chunk.split('\\u0003').join('');",
                "    handleInterrupt();",
                "  }",
                "  buffer += chunk;",
                "  const parts = buffer.split(/\\r|\\n/);",
                "  buffer = parts.pop() ?? '';",
                "  for (const raw of parts) {",
                "    const text = raw.trim();",
                "    if (text) process.stdout.write(`" + config.input_marker + ":${text}\\r\\n`);",
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
    # xterm innerText exposes visual soft wraps. Mobile/WebKit panes can split
    # provider markers, so positive and negative smoke assertions de-wrap lines.
    return needle in text or needle in text.replace("\n", "")


def assert_terminal_text_absent(panel, needle: str) -> None:
    text = panel.inner_text()
    if terminal_text_contains(text, needle):
        raise AssertionError(f"terminal unexpectedly contained {needle!r}; tail={text[-1200:]}")


def wait_for_provider_binding(base_url: str, session_id: str, provider: str, timeout_s: int = 20) -> None:
    started = time.time()
    while time.time() - started < timeout_s:
        summary = request_json(base_url, f"/api/sessions/{session_id}")
        provider_session_id = summary.get("session", {}).get("session", {}).get("providerSessionId")
        if provider_session_id:
            return
        time.sleep(0.2)
    raise AssertionError(f"{provider} native session did not bind providerSessionId")


def assert_session_idle(base_url: str, session_id: str, provider: str) -> None:
    session = request_json(base_url, f"/api/sessions/{session_id}")["session"]["session"]
    if session.get("runtimeState") != "idle":
        raise AssertionError(f"{provider} native session did not return to idle: {session}")


def wait_for_session_idle(base_url: str, session_id: str, provider: str, timeout_s: int = 20) -> None:
    started = time.time()
    last_session: dict[str, Any] | None = None
    while time.time() - started < timeout_s:
        session = request_json(base_url, f"/api/sessions/{session_id}")["session"]["session"]
        last_session = session
        if session.get("runtimeState") == "idle":
            return
        time.sleep(0.2)
    raise AssertionError(f"{provider} native session did not become idle: {last_session}")


def session_runtime_state(base_url: str, session_id: str) -> str | None:
    session = request_json(base_url, f"/api/sessions/{session_id}")["session"]["session"]
    value = session.get("runtimeState")
    return str(value) if value is not None else None


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


def wait_for_opencode_usage(base_url: str, session_id: str, timeout_s: int = 20) -> None:
    started = time.time()
    last_usage: dict[str, Any] | None = None
    while time.time() - started < timeout_s:
        summary = request_json(base_url, f"/api/sessions/{session_id}")
        usage = summary.get("session", {}).get("usage")
        if isinstance(usage, dict):
            last_usage = usage
            if (
                usage.get("source") == "opencode.message.usage"
                and usage.get("usedTokens") == 135
                and usage.get("inputTokens") == 100
                and usage.get("outputTokens") == 20
                and usage.get("reasoningOutputTokens") == 5
                and usage.get("cachedInputTokens") == 7
                and usage.get("totalCostUsd") == 0.0123
                and usage.get("basis") == "turn"
                and usage.get("precision") == "exact"
            ):
                return
        time.sleep(0.2)
    raise AssertionError(f"OpenCode usage did not reach session summary; last={last_usage}")


def assert_opencode_mirror_details(page) -> None:
    reasoning_button = page.get_by_role("button", name="Reasoning").last
    expect(reasoning_button).to_be_visible(timeout=10_000)
    reasoning_button.click()
    expect(page.get_by_text("OpenCode native browser reasoning trace")).to_be_visible(timeout=10_000)
    expect(page.get_by_text("OpenCode browser tool")).to_be_visible(timeout=10_000)
    expect(page.get_by_text("Step 1")).to_be_visible(timeout=10_000)
    expect(page.get_by_text("stop")).to_be_visible(timeout=10_000)


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


def open_sessions_dialog(page) -> None:
    sessions_button = page.locator('button[aria-label="Sessions"]:visible').first
    try:
        sessions_button.click(timeout=5_000)
        return
    except PlaywrightTimeoutError:
        page.locator('button[aria-label="Open sidebar"]:visible').first.click(timeout=30_000)
    page.locator('button[aria-label="Sessions"]:visible').first.click(timeout=30_000)


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


def start_native_session(
    base_url: str,
    workspace: pathlib.Path,
    config: ProviderConfig,
) -> str:
    title = f"{config.provider} native browser smoke"
    started = request_json(
        base_url,
        "/api/sessions/start",
        {
            "provider": config.provider,
            "cwd": str(workspace),
            "liveBackend": "native_tui",
            "title": title,
            **config.request,
            "attach": {
                "client": {
                    "id": "web-user",
                    "kind": "web",
                    "connectionId": f"{config.provider}-native-browser-smoke",
                },
                "mode": "interactive",
                "claimControl": True,
            },
        },
    )["session"]
    session = started["session"]
    if session.get("liveBackend") != "native_tui":
        raise AssertionError(f"{config.provider} did not start as native_tui")
    if bool(session.get("capabilities", {}).get("chatMirror")) is not config.expects_chat_mirror:
        raise AssertionError(f"{config.provider} native session advertised wrong chatMirror capability")
    session_id = str(session["id"])
    STARTED_SESSIONS.append((base_url, session_id))
    if config.expects_chat_mirror:
        wait_for_provider_binding(base_url, session_id, config.provider)
    return session_id


def mark_session_closed(base_url: str, session_id: str) -> None:
    try:
        STARTED_SESSIONS.remove((base_url, session_id))
    except ValueError:
        pass


def exercise_provider(page, base_url: str, workspace: pathlib.Path, config: ProviderConfig) -> dict[str, str]:
    session_id = start_native_session(base_url, workspace, config)
    page.goto(base_url, wait_until="domcontentloaded")
    page.reload(wait_until="domcontentloaded")
    open_sessions_dialog(page)
    page.get_by_role("button", name="Live", exact=True).click(timeout=30_000)
    page.locator(f'button[data-session-id="{session_id}"]:visible').first.click(timeout=30_000)

    if config.expects_chat_mirror:
        chat_button = page.get_by_role("button", name="Chat", exact=True)
        expect(chat_button).to_be_visible(timeout=10_000)
        chat_button.click()
        if config.expected_mirror_text:
            expect(page.get_by_text(config.expected_mirror_text)).to_be_visible(timeout=15_000)
        wait_for_session_idle(base_url, session_id, config.provider)
        terminal_id = session_native_terminal_id(base_url, session_id)
        dirty_draft = f"dirty native {config.provider} draft"
        blocked_chat_prompt = f"blocked while dirty {config.provider} browser native"
        tui_button = page.get_by_role("button", name="TUI", exact=True)
        expect(tui_button).to_be_visible(timeout=10_000)
        tui_button.click()
        panel = page.locator(".terminal-panel").last
        expect(panel).to_be_visible(timeout=10_000)
        send_pty_input(base_url, terminal_id, "web-user", dirty_draft)
        wait_for_native_prompt_state(base_url, session_id, "prompt_dirty")
        page.wait_for_timeout(300)
        page.get_by_role("button", name="Chat", exact=True).click()
        expect(page.get_by_text("Native TUI has an unsent local draft")).to_be_visible(
            timeout=10_000,
        )
        fill_and_submit_chat_composer(page, blocked_chat_prompt)
        page.wait_for_timeout(1000)
        tui_button.click()
        panel = page.locator(".terminal-panel").last
        assert_terminal_text_absent(panel, blocked_chat_prompt)
        send_pty_input(base_url, terminal_id, "web-user", "\u0003")
        wait_for_terminal_text(panel, config.interrupt_marker)
        assert_terminal_text_absent(panel, blocked_chat_prompt)
        page.get_by_role("button", name="Chat", exact=True).click()
        chat_prompt = f"chat composer {config.provider} browser native"
        fill_and_submit_chat_composer(page, chat_prompt)
        tui_button.click()
        panel = page.locator(".terminal-panel").last
        expect(panel).to_be_visible(timeout=10_000)
        wait_for_terminal_text(panel, f"{config.input_marker}:{chat_prompt}")
        page.get_by_role("button", name="Chat", exact=True).click()
        try:
            page.get_by_role("button", name="Stop generating").click(timeout=15_000)
        except Exception as exc:
            runtime_state = session_runtime_state(base_url, session_id)
            raise AssertionError(
                f"{config.provider} Stop generating button was not available; "
                f"runtimeState={runtime_state}"
            ) from exc
        page.get_by_role("button", name="TUI", exact=True).click()
        wait_for_terminal_text(panel, config.interrupt_marker)
        assert_session_idle(base_url, session_id, config.provider)
        if config.provider == "opencode":
            page.get_by_role("button", name="Chat", exact=True).click()
            assert_opencode_mirror_details(page)
            wait_for_opencode_usage(base_url, session_id)
            page.get_by_role("button", name="TUI", exact=True).click()
    else:
        expect(page.get_by_role("button", name="Chat", exact=True)).to_have_count(0, timeout=5_000)
        expect(page.get_by_role("button", name="TUI", exact=True)).to_have_count(0, timeout=5_000)
    panel = page.locator(".terminal-panel").last
    expect(panel).to_be_visible(timeout=10_000)
    wait_for_terminal_text(panel, config.ready_marker)
    for fragment in config.expected_arg_fragments:
        wait_for_terminal_text(panel, fragment)

    prompt = f"hello {config.provider} browser native"
    page.locator(".terminal-canvas").last.click()
    page.keyboard.type(prompt)
    page.locator(".terminal-canvas").last.click()
    page.keyboard.press("Enter")
    try:
        wait_for_terminal_text(panel, f"{config.input_marker}:{prompt}", timeout_s=3)
    except AssertionError:
        page.keyboard.press("Control+M")
        wait_for_terminal_text(panel, f"{config.input_marker}:{prompt}")

    page.reload(wait_until="domcontentloaded")
    open_sessions_dialog(page)
    page.get_by_role("button", name="Live", exact=True).click(timeout=30_000)
    page.locator(f'button[data-session-id="{session_id}"]:visible').first.click(timeout=30_000)
    page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
    panel = page.locator(".terminal-panel").last
    expect(panel).to_be_visible(timeout=10_000)
    wait_for_terminal_text(panel, config.ready_marker)
    wait_for_terminal_text(panel, f"{config.input_marker}:{prompt}")

    foreground_resume_prompt = f"foreground resume {config.provider} browser native"
    terminal_id = session_native_terminal_id(base_url, session_id)
    page.context.set_offline(True)
    send_pty_input(base_url, terminal_id, "web-user", f"{foreground_resume_prompt}\r")
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
        f"{config.input_marker}:{foreground_resume_prompt}",
        timeout_s=20,
    )

    close_session_quietly(base_url, session_id)
    mark_session_closed(base_url, session_id)
    return {"provider": config.provider, "sessionId": session_id}


def main() -> int:
    try:
        preflight_browser_runtime()
    except Exception as exc:
        return print_browser_preflight_error(exc)

    tmp_root = pathlib.Path(tempfile.mkdtemp(prefix="rah-native-provider-browser-"))
    workspace = tmp_root / "workspace"
    rah_home = tmp_root / "rah-home"
    claude_config_dir = tmp_root / "claude-config"
    xdg_data_home = tmp_root / "xdg-data"
    workspace.mkdir(parents=True)
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    env = {
        "RAH_HOME": str(rah_home),
        "CLAUDE_CONFIG_DIR": str(claude_config_dir),
        "XDG_DATA_HOME": str(xdg_data_home),
        "MOCK_OPENCODE_SESSION_ID": "ses_native_opencode_browser",
    }
    for config in CONFIGS:
        binary = tmp_root / f"fake-{config.provider}.js"
        write_fake_provider(binary, config)
        env[config.env_name] = str(binary)

    daemon: subprocess.Popen[str] | None = None
    try:
        daemon = start_daemon(env, port)
        with sync_playwright() as playwright:
            browser = launch_browser(playwright)
            page = browser.new_page(viewport={"width": 1440, "height": 960})
            page.add_init_script(
                "localStorage.setItem('rah-hide-tool-calls-in-chat', 'false');"
            )
            results = [exercise_provider(page, base_url, workspace, config) for config in CONFIGS]
            browser.close()
        print(
            json.dumps(
                {
                    "ok": True,
                    "baseUrl": base_url,
                    "browser": selected_browser_name(),
                    "headless": browser_headless(),
                    "asserted": [
                        "Claude native sessions expose Chat/TUI when JSONL mirror is available",
                        "OpenCode native sessions expose Chat/TUI plus DB mirror text, reasoning, tool, step, and usage",
                        "xterm receives native TUI output",
                        "Chat composer input reaches daemon-owned provider TUI",
                        "Chat composer is blocked while provider native TUI prompt has an unsubmitted draft",
                        "Chat view warns when provider native TUI prompt has an unsubmitted draft",
                        "Stop button sends Ctrl-C to daemon-owned provider TUI",
                        "Stop returns daemon-owned provider TUI sessions to idle",
                        "TUI input reaches daemon-owned provider process",
                        "TUI replay survives page reload for provider sessions",
                        "Foreground recovery catches up provider native TUI output without reselection",
                    ],
                    "results": results,
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
                    "baseUrl": base_url,
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
        for session_base_url, session_id in list(STARTED_SESSIONS):
            close_session_quietly(session_base_url, session_id)
            mark_session_closed(session_base_url, session_id)
        if daemon:
            terminate_process_tree(daemon)
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
