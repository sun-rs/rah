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
from dataclasses import dataclass
from typing import Any
from urllib import error, request

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
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
    "HISTORY-CLAIM-001",
    "CLAUDE-ABORT-CONTEXT-001",
    "CLAUDE-ERROR-001",
    "CLAUDE-ZELLIJ-001",
    "OPENCODE-STOP-001",
    "OPENCODE-MIRROR-001",
    "TUI-SURFACE-001",
    "TUI-EXIT-001",
    "ARCHIVE-001",
]


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


def live_session_ids(base_url: str, provider: str) -> set[str]:
    response = request_json(base_url, "/api/sessions")
    result: set[str] = set()
    for entry in response.get("sessions", []):
        session = entry.get("session", {})
        if session.get("provider") == provider:
            result.add(str(session.get("id")))
    return result


def wait_for_new_live_session(
    base_url: str,
    provider: str,
    before: set[str],
    timeout_s: int = 20,
) -> str:
    started = time.time()
    last_sessions: list[dict[str, Any]] = []
    while time.time() - started < timeout_s:
        response = request_json(base_url, "/api/sessions")
        sessions = [
            entry.get("session", {})
            for entry in response.get("sessions", [])
            if entry.get("session", {}).get("provider") == provider
            and str(entry.get("session", {}).get("id")) not in before
        ]
        last_sessions = sessions
        if sessions:
            sessions.sort(key=lambda item: str(item.get("createdAt", "")), reverse=True)
            return str(sessions[0]["id"])
        time.sleep(0.2)
    raise AssertionError(f"new {provider} live session did not appear; last={last_sessions}")


def spawn_rah_cli(
    base_url: str,
    workspace: pathlib.Path,
    provider: str,
    provider_session_id: str | None = None,
) -> subprocess.Popen[str]:
    args = ["node", "bin/rah.mjs", provider]
    if provider_session_id:
        args.extend(["resume", provider_session_id])
    args.extend(["--mux", "native", "--daemon-url", base_url, "--cwd", str(workspace)])
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
    if not proc:
        return
    if proc.poll() is not None:
        return
    terminate_process_tree(proc)


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
            "  let sessionArgIndex = process.argv.indexOf('--session-id');",
            "  if (sessionArgIndex < 0) sessionArgIndex = process.argv.indexOf('--resume');",
            "  const sessionId = sessionArgIndex >= 0 ? process.argv[sessionArgIndex + 1] : undefined;",
            "  if (!configDir || !sessionId) return;",
            "  const fs = require('node:fs');",
            "  const path = require('node:path');",
            "  const projectId = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');",
            "  const projectDir = path.join(configDir, 'projects', projectId);",
            "  const now = new Date().toISOString();",
            "  fs.mkdirSync(projectDir, { recursive: true });",
            "  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [",
            "    JSON.stringify({ type: 'user', uuid: 'claude-native-browser-user', cwd: process.cwd(), sessionId, timestamp: now, message: { content: 'Claude native browser question\\n<turn_aborted>\\nThe user interrupted the previous turn on purpose.\\n</turn_aborted>' } }),",
            "    JSON.stringify({ type: 'system', uuid: 'claude-native-browser-api-error', subtype: 'api_error', cwd: process.cwd(), sessionId, timestamp: now, error: { status: 503, headers: { server: 'cloudflare', 'x-request-id': 'f589e5e5-1066-4763-abe4-14122f11c486' }, error: { error: { message: 'No available accounts: no available accounts', type: 'api_error' }, type: 'error' }, type: 'api_error' } }),",
            "    JSON.stringify({ type: 'assistant', uuid: 'claude-native-browser-assistant', cwd: process.cwd(), sessionId, timestamp: now, message: { content: [{ type: 'text', text: 'Claude native browser answer' }] } }),",
            "  ].join('\\n') + '\\n');",
            "}, 100);",
        ]
    opencode_history_setup = []
    if config.provider == "opencode":
        opencode_history_setup = [
            "setTimeout(() => {",
            "  const dataHome = process.env.XDG_DATA_HOME;",
            "  const sessionId = openCodeSessionId();",
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
                f"const provider = {json.dumps(config.provider)};",
                "const fs = require('node:fs');",
                "const path = require('node:path');",
                "const { execFileSync } = require('node:child_process');",
                "function sql(value) { return `'${String(value).replace(/'/g, `''`)}'`; }",
                "function dynamicAnswer(text) {",
                "  return `${provider === 'claude' ? 'Claude' : 'OpenCode'} native browser dynamic answer: ${text}`;",
                "}",
                "function appendClaudeTurn(text, turnIndex) {",
                "  const configDir = process.env.CLAUDE_CONFIG_DIR;",
                "  let sessionArgIndex = process.argv.indexOf('--session-id');",
                "  if (sessionArgIndex < 0) sessionArgIndex = process.argv.indexOf('--resume');",
                "  const sessionId = sessionArgIndex >= 0 ? process.argv[sessionArgIndex + 1] : undefined;",
                "  if (!configDir || !sessionId) return;",
                "  const projectId = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');",
                "  const projectDir = path.join(configDir, 'projects', projectId);",
                "  const now = new Date().toISOString();",
                "  fs.mkdirSync(projectDir, { recursive: true });",
                "  fs.appendFileSync(path.join(projectDir, `${sessionId}.jsonl`), [",
                "    JSON.stringify({ type: 'user', uuid: `claude-native-browser-user-${turnIndex}`, cwd: process.cwd(), sessionId, timestamp: now, message: { content: text } }),",
                "    JSON.stringify({ type: 'assistant', uuid: `claude-native-browser-assistant-${turnIndex}`, cwd: process.cwd(), sessionId, timestamp: now, message: { content: [{ type: 'text', text: dynamicAnswer(text) }] } }),",
                "  ].join('\\n') + '\\n');",
                "}",
                "function appendOpenCodeTurn(text, turnIndex) {",
                "  const dataHome = process.env.XDG_DATA_HOME;",
                "  const sessionId = openCodeSessionId();",
                "  if (!dataHome || !sessionId) return;",
                "  const db = path.join(dataHome, 'opencode', 'opencode.db');",
                "  fs.mkdirSync(path.dirname(db), { recursive: true });",
                "  const now = Date.now() + turnIndex * 100;",
                "  const userMessageId = `msg_user_dynamic_${turnIndex}`;",
                "  const assistantMessageId = `msg_assistant_dynamic_${turnIndex}`;",
                "  execFileSync('sqlite3', [db, `",
                "    pragma busy_timeout = 5000;",
                "    create table if not exists project (id text primary key, worktree text, name text, time_updated integer);",
                "    create table if not exists session (id text primary key, project_id text not null, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer);",
                "    create table if not exists message (id text primary key, session_id text, time_created integer, time_updated integer, data text);",
                "    create table if not exists part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);",
                "    insert or replace into project (id, worktree, name, time_updated) values ('project_native', ${sql(process.cwd())}, null, ${now});",
                "    insert or replace into session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived)",
                "      values (${sql(sessionId)}, 'project_native', null, ${sql(process.cwd())}, 'OpenCode native browser smoke', ${now}, ${now + 30}, null);",
                "    insert or replace into message (id, session_id, time_created, time_updated, data)",
                "      values (${sql(userMessageId)}, ${sql(sessionId)}, ${now + 10}, ${now + 10}, ${sql(JSON.stringify({ role: 'user', time: { created: now + 10 } }))});",
                "    insert or replace into message (id, session_id, time_created, time_updated, data)",
                "      values (${sql(assistantMessageId)}, ${sql(sessionId)}, ${now + 20}, ${now + 30}, ${sql(JSON.stringify({ role: 'assistant', parentID: userMessageId, finish: 'stop', time: { created: now + 20, completed: now + 30 } }))});",
                "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
                "      values (${sql(`part_user_dynamic_${turnIndex}`)}, ${sql(userMessageId)}, ${sql(sessionId)}, ${now + 11}, ${now + 11}, ${sql(JSON.stringify({ type: 'text', text }))});",
                "    insert or replace into part (id, message_id, session_id, time_created, time_updated, data)",
                "      values (${sql(`part_assistant_dynamic_${turnIndex}`)}, ${sql(assistantMessageId)}, ${sql(sessionId)}, ${now + 21}, ${now + 30}, ${sql(JSON.stringify({ type: 'text', text: dynamicAnswer(text) }))});",
                "  `]);",
                "}",
                "function appendProviderTurn(text, turnIndex) {",
                "  if (provider === 'claude') appendClaudeTurn(text, turnIndex);",
                "  if (provider === 'opencode') appendOpenCodeTurn(text, turnIndex);",
                "}",
                "function openCodeSessionId() {",
                "  const sessionArgIndex = process.argv.indexOf('--session');",
                "  if (sessionArgIndex >= 0 && process.argv[sessionArgIndex + 1]) {",
                "    return process.argv[sessionArgIndex + 1];",
                "  }",
                "  const base = process.env.MOCK_OPENCODE_SESSION_ID || 'ses_native_opencode_browser';",
                "  return `${base}_${process.pid}`;",
                "}",
                f"process.stdout.write(`{config.ready_marker} args=${{process.argv.slice(2).join('|')}}\\r\\n`);",
                *claude_history_setup,
                *opencode_history_setup,
                "process.stdin.setEncoding('utf8');",
                "if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);",
                "process.stdin.resume();",
                "let buffer = '';",
                "let interruptEscCount = 0;",
                "let turnIndex = 0;",
                "function writePrompt() {",
                "  if (provider === 'opencode') process.stdout.write('Ask anything\\r\\n');",
                "  if (provider === 'claude') process.stdout.write('> \\r\\n');",
                "}",
                f"function handleInterrupt() {{ buffer = ''; process.stdout.write(`{config.interrupt_marker}\\r\\n`); writePrompt(); }}",
                "function handleEscapeInterrupt(count) {",
                "  if (provider !== 'opencode') {",
                "    handleInterrupt();",
                "    return;",
                "  }",
                "  interruptEscCount += count;",
                "  if (interruptEscCount >= 2) {",
                "    interruptEscCount = 0;",
                "    handleInterrupt();",
                "  }",
                "}",
                "process.on('SIGINT', handleInterrupt);",
                "process.stdin.on('data', (chunk) => {",
                "  if (chunk.includes('\\u0003')) {",
                "    chunk = chunk.split('\\u0003').join('');",
                "    handleInterrupt();",
                "  }",
                "  if (chunk.includes('\\u0015') || chunk.includes('\\u000b')) {",
                "    buffer = '';",
                "    chunk = chunk.split('\\u0015').join('').split('\\u000b').join('');",
                "  }",
                "  if (chunk.includes('\\u001b')) {",
                "    const escapeCount = (chunk.match(/\\u001b/g) || []).length;",
                "    chunk = chunk.split('\\u001b').join('');",
                "    handleEscapeInterrupt(escapeCount);",
                "  }",
                "  buffer += chunk;",
                "  const parts = buffer.split(/\\r|\\n/);",
                "  buffer = parts.pop() ?? '';",
                "  for (const raw of parts) {",
                "    const text = raw.trim();",
                "    if (text) {",
                "      if (text === 'exit') {",
                f"        process.stdout.write(`{config.ready_marker}_EXITING\\r\\n`);",
                "        process.exit(0);",
                "      }",
                "      turnIndex += 1;",
                "      process.stdout.write(`" + config.input_marker + ":${text}\\r\\n`);",
                "      const holdForStopSmoke = text.startsWith('chat composer ');",
                "      if (!holdForStopSmoke) {",
                "        appendProviderTurn(text, turnIndex);",
                "        process.stdout.write(`${dynamicAnswer(text)}\\r\\n`);",
                "        writePrompt();",
                "      }",
                "      if (text.startsWith('blocked while dirty ')) writePrompt();",
                "    }",
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
    return (
        needle in text
        or needle in text.replace("\n", "")
        or re.sub(r"\s+", "", needle) in re.sub(r"\s+", "", text)
    )


def terminal_text_count(text: str, needle: str) -> int:
    return max(
        text.count(needle),
        text.replace("\n", "").count(needle),
        re.sub(r"\s+", "", text).count(re.sub(r"\s+", "", needle)),
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


def assert_terminal_text_absent(panel, needle: str) -> None:
    text = panel.inner_text()
    if terminal_text_contains(text, needle):
        raise AssertionError(f"terminal unexpectedly contained {needle!r}; tail={text[-1200:]}")


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


def chat_user_message_texts(page) -> list[str]:
    return page.evaluate(
        """() => [...document.querySelectorAll('[data-testid="chat-user-message"]')]
            .map((node) => `${node.getAttribute('data-feed-key') || '<no-key>'}: ${node.textContent || ''}`)"""
    )


def wait_for_chat_user_message_occurrences(page, needle: str, expected: int, timeout_s: int = 15) -> None:
    started = time.time()
    last_count = 0
    last_texts: list[str] = []
    while time.time() - started < timeout_s:
        last_count = chat_user_message_occurrences(page, needle)
        last_texts = chat_user_message_texts(page)
        if last_count == expected:
            return
        page.wait_for_timeout(200)
    raise AssertionError(
        f"chat user message {needle!r} count did not become {expected}; "
        f"last={last_count}; user_messages={last_texts}"
    )


def dynamic_answer_for(config: ProviderConfig, prompt: str) -> str:
    label = "Claude" if config.provider == "claude" else "OpenCode"
    return f"{label} native browser dynamic answer: {prompt}"


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


def session_provider_session_id(base_url: str, session_id: str) -> str:
    session = request_json(base_url, f"/api/sessions/{session_id}")["session"]["session"]
    value = session.get("providerSessionId")
    if not value:
        raise AssertionError(f"session {session_id} did not expose providerSessionId")
    return str(value)


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


def count_session_history_timeline_text(
    base_url: str,
    session_id: str,
    kind: str,
    text: str,
) -> int:
    return len(session_history_timeline_text_matches(base_url, session_id, kind, text))


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
    while time.time() - started < timeout_s:
        last_matches = session_history_timeline_text_matches(base_url, session_id, kind, text)
        if len(last_matches) == expected:
            return
        time.sleep(0.2)
    raise AssertionError(
        f"session history {kind} text {text!r} count did not become {expected}; "
        f"last={len(last_matches)} matches={last_matches}"
    )


def session_history_timeline_text_matches(
    base_url: str,
    session_id: str,
    kind: str,
    text: str,
) -> list[dict[str, Any]]:
    page = request_json(base_url, f"/api/sessions/{session_id}/history?limit=160")
    return [
        event
        for event in page.get("events", [])
        if event.get("type") == "timeline.item.added"
        and event.get("payload", {}).get("item", {}).get("kind") == kind
        and event.get("payload", {}).get("item", {}).get("text") == text
    ]


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


def select_live_session(page, session_id: str) -> None:
    open_sessions_dialog(page)
    page.get_by_role("button", name="Live", exact=True).click(timeout=30_000)
    page.locator(f'button[data-session-id="{session_id}"]:visible').first.click(timeout=30_000)


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


def resume_native_session(
    base_url: str,
    workspace: pathlib.Path,
    config: ProviderConfig,
    provider_session_id: str,
) -> str:
    resumed = request_json(
        base_url,
        "/api/sessions/resume",
        {
            "provider": config.provider,
            "providerSessionId": provider_session_id,
            "cwd": str(workspace),
            "liveBackend": "native_tui",
            **config.request,
            "attach": {
                "client": {
                    "id": "web-user",
                    "kind": "web",
                    "connectionId": f"{config.provider}-native-browser-resume-smoke",
                },
                "mode": "interactive",
                "claimControl": True,
            },
        },
    )["session"]
    session = resumed["session"]
    if session.get("liveBackend") != "native_tui":
        raise AssertionError(f"{config.provider} resume did not start as native_tui")
    session_id = str(session["id"])
    STARTED_SESSIONS.append((base_url, session_id))
    wait_for_provider_binding(base_url, session_id, config.provider)
    return session_id


def mark_session_closed(base_url: str, session_id: str) -> None:
    try:
        STARTED_SESSIONS.remove((base_url, session_id))
    except ValueError:
        pass


def session_exists(base_url: str, session_id: str) -> bool:
    try:
        request_json(base_url, f"/api/sessions/{session_id}")
        return True
    except error.HTTPError as exc:
        if exc.code == 404:
            return False
        raise


def wait_for_session_absent(base_url: str, session_id: str, timeout_s: int = 20) -> None:
    started = time.time()
    while time.time() - started < timeout_s:
        if not session_exists(base_url, session_id):
            return
        time.sleep(0.2)
    raise AssertionError(f"session {session_id} still exists after {timeout_s}s")


def wait_for_live_session_absent(
    base_url: str,
    provider: str,
    session_id: str,
    timeout_s: int = 20,
) -> None:
    started = time.time()
    while time.time() - started < timeout_s:
        if session_id not in live_session_ids(base_url, provider):
            return
        time.sleep(0.2)
    raise AssertionError(f"{provider} session {session_id} still appears in live sessions")


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
    provider: str,
    timeout_s: int = 20,
) -> None:
    started = time.time()
    last_session: dict[str, Any] | None = None
    while time.time() - started < timeout_s:
        last_session = request_json(base_url, f"/api/sessions/{session_id}")["session"]["session"]
        if last_session.get("runtimeState") != "running":
            return
        time.sleep(0.2)
    raise AssertionError(f"{provider} session {session_id} stayed running after TUI exit: {last_session}")


def wait_for_stored_history_ref(
    base_url: str,
    provider: str,
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
            entry.get("provider") == provider
            and str(entry.get("providerSessionId")) == provider_session_id
            for entry in candidates
        ):
            return
        time.sleep(0.2)
    raise AssertionError(
        f"{provider} provider history {provider_session_id!r} was not retained; "
        f"last={json.dumps(last_response, ensure_ascii=False)[:2000]}"
    )


def exercise_provider_tui_exit(
    page,
    base_url: str,
    workspace: pathlib.Path,
    config: ProviderConfig,
) -> None:
    session_id = start_native_session(base_url, workspace, config)
    try:
        page.reload(wait_until="domcontentloaded")
        select_live_session(page, session_id)
        page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
        panel = page.locator(".terminal-panel").last
        expect(panel).to_be_visible(timeout=10_000)
        wait_for_terminal_text(panel, config.ready_marker)
        terminal_id = session_native_terminal_id(base_url, session_id)
        send_pty_input(base_url, terminal_id, "web-user", "exit\r")
        wait_for_pty_status(base_url, session_id, "exited")
        wait_for_session_not_running(base_url, session_id, config.provider)
        time.sleep(0.5)
        wait_for_pty_status(base_url, session_id, "exited", timeout_s=2)
        mark_session_closed(base_url, session_id)
        artifact_dir = getattr(page, "_rah_artifact_dir", None)
        if artifact_dir:
            page.reload(wait_until="domcontentloaded")
            save_browser_screenshot(page, artifact_dir, f"{config.provider}-tui-exit-live-cleanup")
    finally:
        close_session_quietly(base_url, session_id)
        mark_session_closed(base_url, session_id)


def exercise_provider_archive(
    page,
    base_url: str,
    workspace: pathlib.Path,
    config: ProviderConfig,
) -> None:
    session_id = start_native_session(base_url, workspace, config)
    try:
        provider_session_id = session_provider_session_id(base_url, session_id)
        page.reload(wait_until="domcontentloaded")
        select_live_session(page, session_id)
        page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
        panel = page.locator(".terminal-panel").last
        expect(panel).to_be_visible(timeout=10_000)
        wait_for_terminal_text(panel, config.ready_marker)
        page.get_by_role("button", name="Chat", exact=True).click(timeout=30_000)
        page.locator('button[title="Archive this live session"]:visible').first.click(timeout=30_000)
        page.get_by_role("dialog").filter(has_text="Archive session?").get_by_role(
            "button",
            name="Archive",
            exact=True,
        ).click(timeout=30_000)
        wait_for_session_absent(base_url, session_id)
        wait_for_live_session_absent(base_url, config.provider, session_id)
        assert_session_not_in_pty_stats(base_url, session_id)
        wait_for_stored_history_ref(base_url, config.provider, provider_session_id)
        mark_session_closed(base_url, session_id)
        artifact_dir = getattr(page, "_rah_artifact_dir", None)
        if artifact_dir:
            save_browser_screenshot(page, artifact_dir, f"{config.provider}-archive-live-cleanup")
    finally:
        close_session_quietly(base_url, session_id)
        mark_session_closed(base_url, session_id)


def exercise_provider_cli_modes(
    page,
    base_url: str,
    workspace: pathlib.Path,
    config: ProviderConfig,
) -> dict[str, str]:
    before = live_session_ids(base_url, config.provider)
    cli_proc: subprocess.Popen[str] | None = spawn_rah_cli(base_url, workspace, config.provider)
    session_id: str | None = None
    resume_session_id: str | None = None
    resume_proc: subprocess.Popen[str] | None = None
    try:
        session_id = wait_for_new_live_session(base_url, config.provider, before)
        STARTED_SESSIONS.append((base_url, session_id))
        wait_for_provider_binding(base_url, session_id, config.provider)
        page.goto(base_url, wait_until="domcontentloaded")
        page.reload(wait_until="domcontentloaded")
        select_live_session(page, session_id)
        page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
        panel = page.locator(".terminal-panel").last
        expect(panel).to_be_visible(timeout=10_000)
        wait_for_terminal_text(panel, config.ready_marker)
        cli_prompt = f"rah cli {config.provider} browser native"
        assert cli_proc.stdin is not None
        cli_proc.stdin.write(f"{cli_prompt}\n")
        cli_proc.stdin.flush()
        wait_for_terminal_text(panel, f"{config.input_marker}:{cli_prompt}", timeout_s=20)
        page.get_by_role("button", name="Chat", exact=True).click(timeout=30_000)
        cli_answer = dynamic_answer_for(config, cli_prompt)
        expect(page.get_by_text(cli_answer, exact=True)).to_be_visible(timeout=20_000)
        assert_page_text_order(page, cli_prompt, cli_answer)
        assert_page_text_absent(page, "Unhandled provider event")
        artifact_dir = getattr(page, "_rah_artifact_dir", None)
        if artifact_dir:
            save_browser_screenshot(page, artifact_dir, f"{config.provider}-rah-cli-chat-mirror")

        page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
        panel = page.locator(".terminal-panel").last
        cli_stop_prompt = f"chat composer {config.provider} rah cli stop"
        interrupted_count = count_terminal_text(panel, config.interrupt_marker)
        cli_proc.stdin.write(f"{cli_stop_prompt}\n")
        cli_proc.stdin.flush()
        wait_for_terminal_text(panel, f"{config.input_marker}:{cli_stop_prompt}", timeout_s=20)
        cli_proc.stdin.write("\x1b\x1b" if config.provider == "opencode" else "\x1b")
        cli_proc.stdin.flush()
        wait_for_terminal_text_count(
            panel,
            config.interrupt_marker,
            interrupted_count + 1,
        )
        wait_for_session_idle(base_url, session_id, config.provider)
        if artifact_dir:
            save_browser_screenshot(page, artifact_dir, f"{config.provider}-rah-cli-terminal-stop")

        provider_session_id = session_provider_session_id(base_url, session_id)
        close_session_quietly(base_url, session_id)
        mark_session_closed(base_url, session_id)
        terminate_cli_process(cli_proc)
        cli_proc = None

        before_resume = live_session_ids(base_url, config.provider)
        resume_proc = spawn_rah_cli(base_url, workspace, config.provider, provider_session_id)
        resume_session_id = wait_for_new_live_session(base_url, config.provider, before_resume)
        STARTED_SESSIONS.append((base_url, resume_session_id))
        wait_for_provider_binding(base_url, resume_session_id, config.provider)
        page.reload(wait_until="domcontentloaded")
        select_live_session(page, resume_session_id)
        page.get_by_role("button", name="Chat", exact=True).click(timeout=30_000)
        resume_history_text = config.expected_mirror_text or cli_answer
        expect(page.get_by_text(resume_history_text, exact=True)).to_be_visible(timeout=20_000)
        cli_resume_matches = session_history_timeline_text_matches(
            base_url,
            resume_session_id,
            "assistant_message",
            resume_history_text,
        )
        if len(cli_resume_matches) > 1:
            raise AssertionError(
                f"{config.provider} rah cli resume duplicated {resume_history_text!r}: "
                f"count={len(cli_resume_matches)}"
            )
        assert_page_text_absent(page, "Unhandled provider event")
        if artifact_dir:
            save_browser_screenshot(page, artifact_dir, f"{config.provider}-rah-cli-resume-chat-history")
        close_session_quietly(base_url, resume_session_id)
        mark_session_closed(base_url, resume_session_id)
        terminate_cli_process(resume_proc)
        resume_proc = None
        return {
            "provider": config.provider,
            "cliSessionId": session_id,
            "cliResumeSessionId": resume_session_id,
        }
    finally:
        terminate_cli_process(cli_proc)
        terminate_cli_process(resume_proc)
        close_session_quietly(base_url, session_id)
        close_session_quietly(base_url, resume_session_id)
        if session_id:
            mark_session_closed(base_url, session_id)
        if resume_session_id:
            mark_session_closed(base_url, resume_session_id)


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
            if config.provider == "claude":
                assert_page_text_absent(page, "<turn_aborted>")
                assert_page_text_absent(page, "The user interrupted the previous turn on purpose.")
                compact_error = (
                    "Claude API error — API Error: 503 No available accounts: no available accounts. "
                    "This is a server-side issue, usually temporary."
                )
                expect(page.get_by_text(compact_error, exact=True).first).to_be_visible(timeout=15_000)
                assert_page_text_order(page, "Claude native browser question", "Claude API error")
                assert_page_text_absent(page, "cloudflare")
                assert_page_text_absent(page, "x-request-id")
                assert_page_text_absent(page, "f589e5e5-1066-4763-abe4-14122f11c486")
                assert_page_text_absent(page, '"headers"')
            artifact_dir = getattr(page, "_rah_artifact_dir", None)
            if artifact_dir:
                save_browser_screenshot(page, artifact_dir, f"{config.provider}-chat-mirror")
        wait_for_session_idle(base_url, session_id, config.provider)
        terminal_id = session_native_terminal_id(base_url, session_id)
        dirty_draft = f"dirty native {config.provider} draft"
        blocked_chat_prompt = f"blocked while dirty {config.provider} browser native"
        blocked_chat_prompt_two = f"blocked while dirty {config.provider} browser native two"
        blocked_answer = dynamic_answer_for(config, blocked_chat_prompt)
        blocked_answer_two = dynamic_answer_for(config, blocked_chat_prompt_two)
        tui_button = page.get_by_role("button", name="TUI", exact=True)
        expect(tui_button).to_be_visible(timeout=10_000)
        tui_button.click()
        panel = page.locator(".terminal-panel").last
        expect(panel).to_be_visible(timeout=10_000)
        wait_for_terminal_text(panel, config.ready_marker)
        mirror_prompt = f"mirror order {config.provider} browser native"
        mirror_answer = dynamic_answer_for(config, mirror_prompt)
        send_pty_input(base_url, terminal_id, "web-user", f"{mirror_prompt}\r")
        wait_for_terminal_text(panel, f"{config.input_marker}:{mirror_prompt}")
        page.get_by_role("button", name="Chat", exact=True).click()
        expect(page.get_by_text(mirror_answer, exact=True)).to_be_visible(timeout=20_000)
        assert_page_text_order(page, mirror_prompt, mirror_answer)
        assert_page_text_absent(page, "Unhandled provider event")
        assert_page_text_absent(page, "Loading older history")
        expect(page.get_by_role("button", name="Stop generating")).to_have_count(0, timeout=10_000)
        tui_button.click()
        panel = page.locator(".terminal-panel").last
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
        tui_button.click()
        panel = page.locator(".terminal-panel").last
        assert_terminal_text_absent(panel, blocked_chat_prompt)
        send_pty_input(base_url, terminal_id, "web-user", "\u0003")
        wait_for_terminal_text(panel, config.interrupt_marker)
        wait_for_terminal_text(panel, f"{config.input_marker}:{blocked_chat_prompt}")
        wait_for_terminal_text(panel, blocked_answer, timeout_s=20)
        wait_for_terminal_text(panel, f"{config.input_marker}:{blocked_chat_prompt_two}", timeout_s=20)
        wait_for_terminal_text(panel, blocked_answer_two, timeout_s=20)
        wait_for_session_idle(base_url, session_id, config.provider)
        page.get_by_role("button", name="Chat", exact=True).click()
        expect(page.get_by_text(blocked_answer, exact=True)).to_be_visible(timeout=20_000)
        expect(page.get_by_text(blocked_answer_two, exact=True)).to_be_visible(timeout=20_000)
        assert_page_text_order(page, blocked_chat_prompt, blocked_chat_prompt_two)
        assert_page_text_order(page, blocked_answer, blocked_answer_two)
        artifact_dir = getattr(page, "_rah_artifact_dir", None)
        if artifact_dir:
            save_browser_screenshot(page, artifact_dir, f"{config.provider}-chat-dirty-queued-inputs")
        repeated_prompt = f"repeat {config.provider} browser native"
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
        chat_prompt = f"chat composer {config.provider} browser native"
        fill_and_submit_chat_composer(page, chat_prompt)
        wait_for_chat_user_message_occurrences(page, chat_prompt, 1)
        tui_button.click()
        panel = page.locator(".terminal-panel").last
        expect(panel).to_be_visible(timeout=10_000)
        wait_for_terminal_text(panel, f"{config.input_marker}:{chat_prompt}")
        artifact_dir = getattr(page, "_rah_artifact_dir", None)
        if artifact_dir:
            save_browser_screenshot(page, artifact_dir, f"{config.provider}-web-tui-after-chat-input")
        page.get_by_label("Close Web TUI client").click(timeout=10_000)
        expect(page.get_by_test_id("terminal-client-inactive-overlay")).to_be_visible(timeout=10_000)
        page.get_by_role("button", name="Activate TUI", exact=True).click(timeout=10_000)
        panel = page.locator(".terminal-panel").last
        expect(panel).to_be_visible(timeout=10_000)
        wait_for_terminal_text(panel, f"{config.input_marker}:{chat_prompt}")
        if artifact_dir:
            save_browser_screenshot(page, artifact_dir, f"{config.provider}-web-tui-after-reactivate")
        page.get_by_role("button", name="Chat", exact=True).click()
        interrupted_notice_count = page_text_occurrences(page, "Conversation interrupted")
        try:
            stop_button = page.get_by_role("button", name="Stop generating")
            stop_button.click(timeout=15_000)
            try:
                stop_button.click(timeout=500)
            except Exception:
                pass
        except Exception as exc:
            runtime_state = session_runtime_state(base_url, session_id)
            raise AssertionError(
                f"{config.provider} Stop generating button was not available; "
                f"runtimeState={runtime_state}"
            ) from exc
        page.get_by_role("button", name="TUI", exact=True).click()
        wait_for_terminal_text(panel, config.interrupt_marker)
        wait_for_session_idle(base_url, session_id, config.provider)
        wait_for_terminal_text(panel, config.ready_marker)
        page.get_by_role("button", name="Chat", exact=True).click()
        wait_for_page_text_occurrences(
            page,
            "Conversation interrupted",
            interrupted_notice_count + 1,
        )
        assert_page_text_order(page, chat_prompt, "Conversation interrupted")
        expect(page.get_by_role("button", name="Stop generating")).to_have_count(0, timeout=10_000)
        assert_page_text_absent(page, "Unhandled provider event")
        page.get_by_role("button", name="TUI", exact=True).click()
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
    artifact_dir = getattr(page, "_rah_artifact_dir", None)
    if artifact_dir:
        save_browser_screenshot(page, artifact_dir, f"{config.provider}-web-tui-after-reload")

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

    provider_session_id = session_provider_session_id(base_url, session_id)
    close_session_quietly(base_url, session_id)
    mark_session_closed(base_url, session_id)

    resume_session_id = resume_native_session(base_url, workspace, config, provider_session_id)
    page.reload(wait_until="domcontentloaded")
    open_sessions_dialog(page)
    page.get_by_role("button", name="Live", exact=True).click(timeout=30_000)
    page.locator(f'button[data-session-id="{resume_session_id}"]:visible').first.click(timeout=30_000)
    page.get_by_role("button", name="Chat", exact=True).click(timeout=30_000)
    if config.expected_mirror_text:
        expect(page.get_by_text(config.expected_mirror_text, exact=True)).to_be_visible(timeout=20_000)
        resume_matches = session_history_timeline_text_matches(
            base_url,
            resume_session_id,
            "assistant_message",
            config.expected_mirror_text,
        )
        if len(resume_matches) > 1:
            identities = [
                match.get("payload", {}).get("identity")
                for match in resume_matches
            ]
            raise AssertionError(
                f"{config.provider} resumed history duplicated {config.expected_mirror_text!r}: "
                f"count={len(resume_matches)} identities={json.dumps(identities, ensure_ascii=False)}"
            )
    assert_page_text_absent(page, "Unhandled provider event")
    artifact_dir = getattr(page, "_rah_artifact_dir", None)
    if artifact_dir:
        save_browser_screenshot(page, artifact_dir, f"{config.provider}-web-resume-chat-history")
    close_session_quietly(base_url, resume_session_id)
    mark_session_closed(base_url, resume_session_id)
    return {"provider": config.provider, "sessionId": session_id, "resumeSessionId": resume_session_id}


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
    artifact_dir = browser_artifact_dir("native-provider-browser")
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
            setattr(page, "_rah_artifact_dir", artifact_dir)
            page.add_init_script(
                "localStorage.setItem('rah-hide-tool-calls-in-chat', 'false');"
            )
            results = [exercise_provider(page, base_url, workspace, config) for config in CONFIGS]
            cli_results = [
                exercise_provider_cli_modes(page, base_url, workspace, config)
                for config in CONFIGS
            ]
            for config in CONFIGS:
                exercise_provider_tui_exit(page, base_url, workspace, config)
                exercise_provider_archive(page, base_url, workspace, config)
            browser.close()
        print(
            json.dumps(
                {
                    "ok": True,
                    "baseUrl": base_url,
                    "browser": selected_browser_name(),
                    "headless": browser_headless(),
                    "caseIds": CASE_IDS,
                    "screenshots": SCREENSHOTS,
                    "asserted": [
                        "Claude native sessions expose Chat/TUI when JSONL mirror is available",
                        "OpenCode native sessions expose Chat/TUI plus DB mirror text, reasoning, tool, step, and usage",
                        "xterm receives native TUI output",
                        "provider history mirror updates dynamically after native TUI input",
                        "Chat renders provider user messages before assistant replies",
                        "Chat does not show loading-history or unhandled-provider-event noise for new live sessions",
                        "Claude structured 503/429-style API errors render as compact warnings without raw headers",
                        "Chat composer input reaches daemon-owned provider TUI",
                        "Web TUI close and activate restores provider TUI replay",
                        "Chat composer is blocked while provider native TUI prompt has an unsubmitted draft",
                        "Chat view warns when provider native TUI prompt has an unsubmitted draft",
                        "Stop button sends provider-native interrupt keys to daemon-owned provider TUI",
                        "Stop returns daemon-owned provider TUI sessions to idle",
                        "Multiple queued Chat prompts drain in order after prompt clears",
                        "TUI input reaches daemon-owned provider process",
                        "TUI replay survives page reload for provider sessions",
                        "Foreground recovery catches up provider native TUI output without reselection",
                        "Web resume opens provider history without duplicating existing assistant messages",
                        "rah <provider> terminal launch can be observed in browser Chat/TUI",
                        "rah <provider> terminal stop is mirrored back to the browser",
                        "rah <provider> resume can be observed in browser Chat without duplicated history",
                        "provider TUI process exit marks PTY as exited and leaves the session not running",
                        "Archive closes provider live sessions and PTY state while retaining provider history",
                    ],
                    "results": results,
                    "cliResults": cli_results,
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
                    "screenshots": SCREENSHOTS,
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
