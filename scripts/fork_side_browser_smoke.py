from __future__ import annotations

import json
import pathlib
import re
import tempfile
import time
from typing import Any
from urllib import error, request

from playwright.sync_api import expect, sync_playwright

from native_codex_browser_smoke import (
    browser_artifact_dir,
    free_port,
    launch_browser,
    start_daemon,
)
from native_smoke_process import terminate_process_tree
from safe_trash import move_path_to_trash


def progress(message: str) -> None:
    print(f"[fork-side-smoke] {message}", flush=True)


def write_fake_codex(path: pathlib.Path, request_log: pathlib.Path, workspace: pathlib.Path) -> None:
    path.write_text(
        "\n".join(
            [
                "#!/usr/bin/env node",
                "const fs = require('node:fs');",
                "const readline = require('node:readline');",
                "const rl = readline.createInterface({ input: process.stdin });",
                f"const requestLog = {json.dumps(str(request_log))};",
                f"const workspace = {json.dumps(str(workspace))};",
                "let sequence = 0;",
                "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
                "const log = (message) => fs.appendFileSync(requestLog, JSON.stringify(message) + '\\n');",
                "const thread = (id) => ({ id, status: { type: 'idle' }, cwd: workspace, model: 'gpt-side-smoke', turns: [] });",
                "rl.on('line', (line) => {",
                "  const message = JSON.parse(line);",
                "  log({ method: message.method, params: message.params });",
                "  if (message.id === undefined) return;",
                "  if (message.method === 'initialize') return send({ id: message.id, result: {} });",
                "  if (message.method === 'model/list') return send({ id: message.id, result: { data: [], nextCursor: null } });",
                "  if (message.method === 'account/read') return send({ id: message.id, result: { account: null, requiresOpenaiAuth: false } });",
                "  if (message.method === 'config/read') return send({ id: message.id, result: { config: {} } });",
                "  if (message.method === 'thread/list') return send({ id: message.id, result: { data: [], nextCursor: null } });",
                "  if (message.method === 'thread/start') {",
                "    sequence += 1;",
                "    return send({ id: message.id, result: { thread: thread(`thread-parent-${sequence}`), cwd: workspace, model: 'gpt-side-smoke' } });",
                "  }",
                "  if (message.method === 'thread/fork') {",
                "    sequence += 1;",
                "    const prefix = message.params?.ephemeral ? 'thread-side' : 'thread-fork';",
                "    return send({ id: message.id, result: { thread: thread(`${prefix}-${sequence}`), cwd: workspace, model: 'gpt-side-smoke' } });",
                "  }",
                "  if (message.method === 'thread/read') return send({ id: message.id, result: { thread: thread(message.params?.threadId || 'thread-unknown') } });",
                "  if (message.method === 'thread/goal/get') return send({ id: message.id, result: { goal: null } });",
                "  if (message.method === 'thread/unsubscribe') return send({ id: message.id, result: { status: 'unsubscribed' } });",
                "  return send({ id: message.id, result: {} });",
                "});",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


def request_json(
    base_url: str,
    path: str,
    token: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    headers = {
        "authorization": f"Bearer {token}",
        "x-rah-client": "web",
    }
    data = None
    if payload is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(payload).encode()
    req = request.Request(f"{base_url}{path}", data=data, headers=headers)
    try:
        with request.urlopen(req, timeout=120) as response:
            body = response.read()
            return json.loads(body) if body else {}
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} {exc.reason} for {path}: {body}") from exc


def session_rows(base_url: str, token: str) -> list[dict[str, Any]]:
    return [
        entry["session"]
        for entry in request_json(base_url, "/api/sessions", token)["sessions"]
    ]


def wait_for_child(
    base_url: str,
    token: str,
    parent_id: str,
    kind: str,
    timeout_s: int = 20,
) -> dict[str, Any]:
    started = time.time()
    while time.time() - started < timeout_s:
        for session in session_rows(base_url, token):
            relationship = session.get("relationship") or {}
            if relationship.get("parentSessionId") == parent_id and relationship.get("kind") == kind:
                return session
        time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {kind} child of {parent_id}")


def wait_for_absent(base_url: str, token: str, session_id: str, timeout_s: int = 20) -> None:
    started = time.time()
    while time.time() - started < timeout_s:
        if all(session["id"] != session_id for session in session_rows(base_url, token)):
            return
        time.sleep(0.1)
    raise AssertionError(f"session remained live: {session_id}")


def open_live_session(page, session_id: str) -> None:
    page.get_by_role("button", name="Chats", exact=True).first.click(timeout=30_000)
    page.get_by_role("tab", name="Recent", exact=True).click(timeout=30_000)
    page.locator(f'button[data-session-id="{session_id}"]:visible').first.click(timeout=30_000)


def open_session_actions(page) -> None:
    page.get_by_role("button", name="Session actions", exact=True).first.click(timeout=30_000)


def remembered_canvas_state(session_id: str) -> str:
    return json.dumps(
        {
            "layout": {
                "kind": "split",
                "id": "browser-smoke-two-horizontal",
                "axis": "horizontal",
                "ratio": 0.5,
                "first": {"kind": "pane", "paneId": "canvas-1"},
                "second": {"kind": "pane", "paneId": "canvas-2"},
            },
            "activePaneId": "canvas-1",
            "targets": {
                "canvas-1": {"kind": "session", "sessionId": session_id},
                "canvas-2": {"kind": "empty"},
                "canvas-3": {"kind": "empty"},
                "canvas-4": {"kind": "empty"},
            },
            "rightPanelsOpen": {
                "canvas-1": False,
                "canvas-2": False,
                "canvas-3": False,
                "canvas-4": False,
            },
        }
    )


def main() -> int:
    tmp_root = pathlib.Path(tempfile.mkdtemp(prefix="rah-fork-side-browser-"))
    workspace = tmp_root / "workspace"
    rah_home = tmp_root / "rah-home"
    codex_home = tmp_root / "codex-home"
    fake_codex = tmp_root / "fake-codex"
    request_log = tmp_root / "codex-requests.jsonl"
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    artifact_dir = browser_artifact_dir("fork-side-browser")
    daemon = None
    browser = None
    succeeded = False

    try:
        workspace.mkdir(parents=True)
        codex_home.mkdir(parents=True)
        write_fake_codex(fake_codex, request_log, workspace)
        daemon = start_daemon(
            {
                "RAH_HOME": str(rah_home),
                "CODEX_HOME": str(codex_home),
                "RAH_CODEX_BINARY": str(fake_codex),
                "RAH_CODEX_APP_SERVER_TRANSPORT": "stdio",
            },
            port,
        )
        progress(f"daemon ready at {base_url}")
        management_token = (rah_home / "auth" / "management-token").read_text().strip()
        request_json(base_url, "/api/workspaces/add", management_token, {"dir": str(workspace)})
        started = request_json(
            base_url,
            "/api/sessions/start",
            management_token,
            {
                "provider": "codex",
                "cwd": str(workspace),
                "liveBackend": "native_local_server",
                "title": "Fork Side Browser Parent",
                "attach": {
                    "client": {
                        "id": "web-user",
                        "kind": "web",
                        "connectionId": "fork-side-browser-smoke",
                    },
                    "mode": "interactive",
                    "claimControl": True,
                },
            },
        )["session"]
        parent_id = started["session"]["id"]
        progress(f"parent started: {parent_id}")

        with sync_playwright() as playwright:
            browser = launch_browser(playwright)
            desktop = browser.new_context(viewport={"width": 1440, "height": 960})
            desktop.add_cookies(
                [{"name": "rah_device", "value": management_token, "url": base_url}]
            )
            page = desktop.new_page()
            page.goto(base_url, wait_until="domcontentloaded")
            open_live_session(page, parent_id)
            progress("parent opened in desktop browser")

            open_session_actions(page)
            expect(page.get_by_role("button", name="Continue in new task", exact=True)).to_be_visible()
            expect(page.get_by_role("button", name="Open Side task", exact=True)).to_be_visible()
            page.get_by_role("button", name="Open Side task", exact=True).click()
            try:
                side = wait_for_child(base_url, management_token, parent_id, "side")
            except Exception:
                page.screenshot(path=str(artifact_dir / "side-create-failed.png"), full_page=False)
                print(page.locator("body").inner_text()[-4_000:])
                if request_log.exists():
                    print(request_log.read_text()[-8_000:])
                raise
            side_id = side["id"]
            expect(page.get_by_text("1 Side task", exact=True)).to_be_visible(timeout=20_000)
            expect(
                page.locator('[title="Side of Fork Side Browser Parent"]:visible').last
            ).to_be_visible()
            progress(f"Side created: {side_id}")

            page.get_by_role("button", name="Chats", exact=True).first.click()
            page.get_by_role("tab", name="Recent", exact=True).click()
            expect(page.locator(f'button[data-session-id="{side_id}"]')).to_have_count(0)
            page.keyboard.press("Escape")

            page.evaluate(
                "([key, value]) => window.localStorage.setItem(key, value)",
                ["rah-canvas-state-v2", remembered_canvas_state(parent_id)],
            )
            page.set_viewport_size({"width": 390, "height": 844})
            page.reload(wait_until="domcontentloaded")
            page.get_by_role("button", name="Open sidebar", exact=True).first.click(timeout=30_000)
            page.get_by_role("button", name="Canvas", exact=True).click(timeout=30_000)
            page.get_by_role("button", name="Maximize pane", exact=True).first.click(timeout=30_000)
            expect(page.get_by_role("button", name="Main", exact=True)).to_be_visible()
            side_tab = page.get_by_role(
                "button",
                name=re.compile(r"^Open Side of Fork Side Browser Parent, Ready$"),
            )
            expect(side_tab).to_be_visible()
            side_tab.click()
            expect(
                page.locator('[title="Side of Fork Side Browser Parent"]:visible').last
            ).to_be_visible()
            expect(
                page.get_by_role(
                    "button",
                    name="Discard Side of Fork Side Browser Parent",
                    exact=True,
                )
            ).to_be_visible()
            page.screenshot(path=str(artifact_dir / "mobile-side-tab.png"), full_page=False)
            progress("narrow Side tabs verified")

            page.set_viewport_size({"width": 1440, "height": 960})
            page.reload(wait_until="domcontentloaded")
            page.get_by_role("button", name="Canvas", exact=True).click(timeout=30_000)
            expect(page.locator('[title="1 open Side task"]')).to_be_visible(timeout=20_000)
            page.get_by_role("button", name="Maximize pane", exact=True).first.click()
            expect(page.get_by_text("1 Side task", exact=True)).to_be_visible(timeout=20_000)
            stack_button = page.get_by_role(
                "button", name="Arrange Side tasks in a vertical stack", exact=True
            )
            columns_button = page.get_by_role(
                "button", name="Arrange Side tasks in columns", exact=True
            )
            stack_button.click()
            expect(stack_button).to_have_attribute("aria-pressed", "true")
            columns_button.click()
            expect(columns_button).to_have_attribute("aria-pressed", "true")
            page.screenshot(path=str(artifact_dir / "desktop-side-columns.png"), full_page=False)
            progress("desktop Canvas Side layout verified")

            page.get_by_role("button", name="Close canvas view", exact=True).click()
            open_live_session(page, parent_id)
            open_session_actions(page)
            page.get_by_role("button", name="Continue in new task", exact=True).click()
            fork = wait_for_child(base_url, management_token, parent_id, "fork")
            fork_id = fork["id"]
            progress(f"persistent fork created: {fork_id}")
            expect(
                page.get_by_title("Fork Side Browser Parent (2)", exact=True).last
            ).to_be_visible(timeout=20_000)

            page.get_by_role("button", name="Chats", exact=True).first.click()
            page.get_by_role("tab", name="Recent", exact=True).click()
            expect(page.locator(f'button[data-session-id="{fork_id}"]:visible')).to_have_count(1)
            expect(page.locator(f'button[data-session-id="{side_id}"]')).to_have_count(0)
            page.keyboard.press("Escape")

            request_json(
                base_url,
                f"/api/sessions/{parent_id}/close",
                management_token,
                {"clientId": "web-user"},
            )
            wait_for_absent(base_url, management_token, side_id)
            assert any(
                session["id"] == fork_id
                for session in session_rows(base_url, management_token)
            )
            progress("parent close removed Side and preserved persistent fork")

            request_json(
                base_url,
                f"/api/sessions/{fork_id}/close",
                management_token,
                {"clientId": "web-user"},
            )
            wait_for_absent(base_url, management_token, fork_id)
            page.get_by_role("button", name="Chats", exact=True).first.click(timeout=30_000)
            page.get_by_role("tab", name="Recent", exact=True).click(timeout=30_000)
            stopped_fork_row = page.locator(
                f'button[data-provider-session-id="{fork["providerSessionId"]}"]:visible'
            )
            expect(stopped_fork_row).to_have_count(1, timeout=20_000)
            expect(stopped_fork_row).to_have_attribute(
                "title", "Fork Side Browser Parent (2)"
            )
            progress("stopped Fork remained in Chats with its numbered title")
            desktop.close()

        requests = [json.loads(line) for line in request_log.read_text().splitlines() if line]
        side_fork = next(
            request
            for request in requests
            if request["method"] == "thread/fork" and request["params"].get("ephemeral") is True
        )
        persistent_fork = next(
            request
            for request in requests
            if request["method"] == "thread/fork" and request["params"].get("ephemeral") is False
        )
        assert side_fork["params"]["threadSource"] == "sideConversation"
        assert persistent_fork["params"]["threadSource"] == "fork"
        assert any(
            request["method"] == "thread/name/set"
            and request["params"].get("threadId") == fork["providerSessionId"]
            and request["params"].get("name") == "Fork Side Browser Parent (2)"
            for request in requests
        )
        succeeded = True
        print(f"PASS fork/side browser smoke; artifacts={artifact_dir}")
        return 0
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
        if daemon is not None:
            terminate_process_tree(daemon)
            stdout, stderr = daemon.communicate(timeout=5)
            if not succeeded and (stdout or stderr):
                print(f"daemon stdout:\n{stdout}\ndaemon stderr:\n{stderr}")
        if succeeded and tmp_root.exists():
            move_path_to_trash(tmp_root)
        elif tmp_root.exists():
            print(f"preserved failed smoke environment: {tmp_root}")


if __name__ == "__main__":
    raise SystemExit(main())
