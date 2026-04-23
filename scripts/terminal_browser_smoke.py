from __future__ import annotations

import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib import request

from playwright.sync_api import expect, sync_playwright


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

    canvas = page.locator(".terminal-canvas").last
    canvas.click()
    page.keyboard.type(f"printf '{marker}\\n'")
    page.keyboard.press("Enter")
    assert_terminal_output(panel, marker)

    page.get_by_label("Close terminal").click()
    expect(panel).not_to_be_visible(timeout=10_000)


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
            bridge_input = mobile_page.locator(".terminal-ios-input").last
            bridge_input.fill("printf 'RAH_TERMINAL_MOBILE_OK\\n'")
            bridge_input.press("Enter")
            assert_terminal_output(mobile_panel, "RAH_TERMINAL_MOBILE_OK")

            bridge_input.fill("printf 'SYMBOL-[]{}@#'\\n")
            bridge_input.press("Enter")
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

            mobile_page.get_by_label("Close terminal").click()
            expect(mobile_panel).not_to_be_visible(timeout=10_000)

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
            run_terminal_smoke(split_page, workspace, "RAH_TERMINAL_SPLIT_OK", mobile=True)

            result["browserSmoke"] = "ok"
            print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
            mobile_context.close()
            tablet_context.close()
            split_context.close()
            browser.close()

        return 0
    finally:
        try:
            request_json(base_url, "/api/workspaces/remove", {"dir": workspace})
        except Exception:
            pass
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
