from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib import request

from playwright.sync_api import expect, sync_playwright

from rah_smoke_cleanup import cleanup_smoke_workspace


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


def assert_terminal_output(panel, needle: str, *, timeout_ms: int = 10_000) -> None:
    started = time.time()
    while (time.time() - started) * 1000 < timeout_ms:
        output = panel.inner_text()
        if needle in output:
            return
        panel.page.wait_for_timeout(200)
    raise AssertionError(f"Terminal output did not contain {needle!r}.")


def send_mobile_bridge_command(page, command: str) -> None:
    bridge_input = page.locator(".terminal-ios-input").last
    expect(bridge_input).to_be_visible(timeout=10_000)
    bridge_input.click()
    bridge_input.fill(command)
    bridge_input.press("Enter")


def send_desktop_terminal_command(page, command: str) -> None:
    canvas = page.locator(".terminal-canvas").last
    expect(canvas).to_be_visible(timeout=10_000)
    canvas.click()
    page.keyboard.type(command, delay=25)
    page.keyboard.press("Enter")


def active_terminal_id(page) -> str:
    dialog = page.get_by_test_id("workbench-terminal-dialog")
    expect(dialog).to_be_visible(timeout=10_000)
    started = time.time()
    while (time.time() - started) * 1000 < 10_000:
        terminal_id = dialog.get_attribute("data-terminal-id")
        if terminal_id:
            return terminal_id
        page.wait_for_timeout(100)
    raise AssertionError("Terminal dialog did not expose an active terminal id.")


def send_pty_input_via_page(page, terminal_id: str, data: str) -> None:
    page.evaluate(
        """async ({ terminalId, data }) => {
            const url = new URL(`/api/pty/${terminalId}?replay=false`, window.location.href);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            const socket = new WebSocket(url.href);
            await new Promise((resolve, reject) => {
                const timer = window.setTimeout(() => reject(new Error("PTY websocket open timeout")), 5000);
                socket.addEventListener("open", () => {
                    window.clearTimeout(timer);
                    resolve(undefined);
                }, { once: true });
                socket.addEventListener("error", () => {
                    window.clearTimeout(timer);
                    reject(new Error("PTY websocket failed"));
                }, { once: true });
            });
            socket.send(JSON.stringify({
                type: "pty.input",
                sessionId: terminalId,
                clientId: "terminal-browser-smoke",
                data,
            }));
            socket.close();
        }""",
        {"terminalId": terminal_id, "data": data},
    )


def hide_terminal_dialog(page, panel) -> None:
    page.get_by_label("Hide terminal window").click()
    expect(panel).not_to_be_visible(timeout=10_000)


def terminate_active_terminal(page, panel) -> None:
    page.get_by_label("Terminate", exact=False).last.click()
    expect(page.get_by_text("Terminate terminal?")).to_be_visible(timeout=10_000)
    page.get_by_role("button", name="Terminate").last.click()
    expect(panel).not_to_be_visible(timeout=10_000)


def reopen_terminal_dialog(page, *, mobile: bool) -> None:
    wait_for_terminal_entrypoint(page, mobile=mobile)
    page.get_by_role("button", name="Open terminal").click()


def wait_for_terminal_entrypoint(page, *, mobile: bool) -> None:
    started = time.time()
    while (time.time() - started) * 1000 < 10_000:
        if page.get_by_role("button", name="Open terminal").count() > 0:
            return
        if mobile and page.get_by_role("button", name="Open inspector").count() > 0:
            page.get_by_role("button", name="Open inspector").click()
        if not mobile and page.get_by_role("button", name="Expand inspector").count() > 0:
            page.get_by_role("button", name="Expand inspector").click()
        page.wait_for_timeout(250)
    raise AssertionError("Terminal entrypoint did not become visible.")


def open_terminal_from_workspace(page, workspace: str, *, mobile: bool) -> None:
    expect(page.get_by_text("What would you like to build?")).to_be_visible(timeout=30_000)
    workspace_name = Path(workspace).name
    if mobile:
        page.get_by_role("button", name="Open sidebar").click()
        sidebar_scope = page.locator('[role="dialog"]').last
    else:
        sidebar_scope = page.locator("aside").first
    sidebar_scope.get_by_text(workspace_name).first.click()
    page.wait_for_timeout(500)
    wait_for_terminal_entrypoint(page, mobile=mobile)
    page.get_by_role("button", name="Open terminal").click()


def run_terminal_smoke(page, workspace: str, marker: str, *, mobile: bool = False) -> None:
    open_terminal_from_workspace(page, workspace, mobile=mobile)

    panel = page.locator(".terminal-panel").last
    expect(panel).to_be_visible(timeout=10_000)
    page.wait_for_timeout(750)
    terminal_id = active_terminal_id(page)

    bridge = page.locator(".terminal-ios-input-bridge").last
    if bridge.count() > 0 and bridge.is_visible():
        if mobile:
            send_mobile_bridge_command(page, f"printf '{marker}\\n'")
        else:
            send_pty_input_via_page(page, terminal_id, f"printf '{marker}\\n'\r")
    else:
        send_desktop_terminal_command(page, f"printf '{marker}\\n'")
    assert_terminal_output(panel, marker)

    after_hide_marker = f"{marker}_AFTER_HIDE"
    if bridge.count() > 0 and bridge.is_visible():
        if mobile:
            send_mobile_bridge_command(page, f"sh -c \"sleep 1; printf '{after_hide_marker}\\n'\"")
        else:
            send_pty_input_via_page(page, terminal_id, f"sh -c \"sleep 1; printf '{after_hide_marker}\\n'\"\r")
    else:
        send_desktop_terminal_command(page, f"sh -c \"sleep 1; printf '{after_hide_marker}\\n'\"")
    hide_terminal_dialog(page, panel)
    page.wait_for_timeout(1_500)
    reopen_terminal_dialog(page, mobile=mobile)
    panel = page.locator(".terminal-panel").last
    expect(panel).to_be_visible(timeout=10_000)
    assert_terminal_output(panel, after_hide_marker)
    terminate_active_terminal(page, panel)


def main() -> int:
    base_url = os.environ.get("RAH_BASE_URL", "http://127.0.0.1:43111")
    workspace = tempfile.mkdtemp(prefix="rah-terminal-browser-")
    result: dict[str, Any] = {"baseUrl": base_url, "workspace": workspace}

    try:
        request_json(base_url, "/api/workspaces/add", {"dir": workspace})
        request_json(base_url, "/api/workspaces/select", {"dir": workspace})

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1600, "height": 1100})
            page = context.new_page()
            page.on("dialog", lambda dialog: dialog.accept())
            page.goto(base_url, wait_until="domcontentloaded")
            run_terminal_smoke(page, workspace, "RAH_TERMINAL_BROWSER_OK")

            mobile_context = browser.new_context(
                viewport={"width": 390, "height": 844},
                is_mobile=True,
                has_touch=True,
            )
            mobile_page = mobile_context.new_page()
            mobile_page.on("dialog", lambda dialog: dialog.accept())
            mobile_page.goto(base_url, wait_until="domcontentloaded")
            open_terminal_from_workspace(mobile_page, workspace, mobile=True)
            mobile_panel = mobile_page.locator(".terminal-panel").last
            expect(mobile_panel).to_be_visible(timeout=10_000)
            bridge = mobile_page.locator(".terminal-ios-input-bridge").last
            expect(bridge).to_be_visible(timeout=10_000)
            mobile_page.wait_for_timeout(750)
            bridge_input = mobile_page.locator(".terminal-ios-input").last
            send_mobile_bridge_command(mobile_page, "printf 'RAH_TERMINAL_MOBILE_OK\\n'")
            assert_terminal_output(mobile_panel, "RAH_TERMINAL_MOBILE_OK")

            send_mobile_bridge_command(mobile_page, "printf 'SYMBOL-[]{}@#'\\n")
            assert_terminal_output(mobile_panel, "SYMBOL-[]{}@#")

            mobile_page.evaluate(
                """() => {
                    const input = document.querySelector('.terminal-ios-input');
                    if (!(input instanceof HTMLInputElement)) {
                      throw new Error('terminal ios bridge input not found');
                    }
                    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
                    input.value = '中文';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
                }"""
            )
            bridge_input.press("Enter")
            assert_terminal_output(mobile_panel, "中文")

            terminate_active_terminal(mobile_page, mobile_panel)

            tablet_context = browser.new_context(
                viewport={"width": 834, "height": 1194},
                has_touch=True,
            )
            tablet_page = tablet_context.new_page()
            tablet_page.on("dialog", lambda dialog: dialog.accept())
            tablet_page.goto(base_url, wait_until="domcontentloaded")
            run_terminal_smoke(tablet_page, workspace, "RAH_TERMINAL_IPAD_OK")

            split_context = browser.new_context(
                viewport={"width": 694, "height": 1112},
                has_touch=True,
            )
            split_page = split_context.new_page()
            split_page.on("dialog", lambda dialog: dialog.accept())
            split_page.goto(base_url, wait_until="domcontentloaded")
            open_terminal_from_workspace(split_page, workspace, mobile=True)
            split_panel = split_page.locator(".terminal-panel").last
            expect(split_panel).to_be_visible(timeout=10_000)
            split_bridge = split_page.locator(".terminal-ios-input-bridge").last
            expect(split_bridge).to_be_visible(timeout=10_000)
            split_page.wait_for_timeout(750)
            send_mobile_bridge_command(split_page, "printf 'RAH_TERMINAL_SPLIT_OK\\n'")
            assert_terminal_output(split_panel, "RAH_TERMINAL_SPLIT_OK")
            terminate_active_terminal(split_page, split_panel)

            result["browserSmoke"] = "ok"
            print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
            mobile_context.close()
            tablet_context.close()
            split_context.close()
            browser.close()

        return 0
    finally:
        cleanup_smoke_workspace(base_url, workspace)


if __name__ == "__main__":
    raise SystemExit(main())
