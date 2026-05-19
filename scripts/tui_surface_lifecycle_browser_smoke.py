from __future__ import annotations

import json
import pathlib
import tempfile
import time
import traceback
import uuid

from playwright.sync_api import expect, sync_playwright

from native_codex_browser_smoke import (
    browser_artifact_dir,
    browser_headless,
    close_session_quietly,
    free_port,
    launch_browser,
    open_live_session,
    preflight_browser_runtime,
    request_json,
    save_browser_screenshot,
    selected_browser_name,
    start_codex_browser_session,
    start_daemon,
    wait_for_terminal_text,
    write_fake_codex,
)
from native_smoke_process import terminate_process_tree
from safe_trash import move_path_to_trash


CASE_IDS = [
    "TUI-LIFECYCLE-SESSION-CHAT-TOGGLE-001",
    "TUI-LIFECYCLE-SESSION-MODAL-001",
    "TUI-LIFECYCLE-SESSION-SWITCH-AUTO-REATTACH-001",
    "TUI-LIFECYCLE-MANUAL-DETACH-REACTIVATE-001",
]


def expect_inactive_overlay_absent(page, *, timeout_ms: int = 5_000) -> None:
    expect(page.get_by_test_id("terminal-client-inactive-overlay")).to_have_count(
        0,
        timeout=timeout_ms,
    )


def main() -> int:
    try:
        preflight_browser_runtime()
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "phase": "browser_preflight",
                    "error": str(exc),
                    "browser": selected_browser_name(),
                    "headless": browser_headless(),
                },
                ensure_ascii=False,
                indent=2,
            ),
        )
        return 1

    tmp_root = pathlib.Path(tempfile.mkdtemp(prefix="rah-tui-surface-browser-"))
    workspace = tmp_root / "workspace"
    rah_home = tmp_root / "rah-home"
    codex_home = tmp_root / "codex-home"
    fake_codex = tmp_root / "fake-codex.js"
    base_provider_session_id = str(uuid.uuid4())
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    artifact_dir = browser_artifact_dir("tui-surface-lifecycle")
    daemon = None
    session_a: str | None = None
    session_b: str | None = None

    try:
        workspace.mkdir(parents=True)
        (codex_home / "sessions").mkdir(parents=True)
        write_fake_codex(fake_codex)
        daemon = start_daemon(
            {
                "RAH_HOME": str(rah_home),
                "CODEX_HOME": str(codex_home),
                "RAH_CODEX_BINARY": str(fake_codex),
                "MOCK_CODEX_SESSION_ID": base_provider_session_id,
            },
            port,
        )
        request_json(base_url, "/api/workspaces/add", {"dir": str(workspace)})
        request_json(base_url, "/api/workspaces/select", {"dir": str(workspace)})

        session_a, _provider_a = start_codex_browser_session(
            base_url,
            workspace,
            "tui-surface-lifecycle-a",
            "TUI lifecycle A",
        )
        session_b, _provider_b = start_codex_browser_session(
            base_url,
            workspace,
            "tui-surface-lifecycle-b",
            "TUI lifecycle B",
        )

        with sync_playwright() as playwright:
            browser = launch_browser(playwright)
            page = browser.new_page(viewport={"width": 1440, "height": 960})
            page.goto(base_url, wait_until="domcontentloaded")
            page.reload(wait_until="domcontentloaded")

            open_live_session(page, session_a)
            page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
            panel_a = page.locator(".terminal-panel").last
            expect(panel_a).to_be_visible(timeout=10_000)
            wait_for_terminal_text(panel_a, "RAH_NATIVE_CODEX_BROWSER_READY")
            expect_inactive_overlay_absent(page)

            page.get_by_role("button", name="Chat", exact=True).click(timeout=30_000)
            page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
            panel_a = page.locator(".terminal-panel").last
            expect(panel_a).to_be_visible(timeout=10_000)
            wait_for_terminal_text(panel_a, "RAH_NATIVE_CODEX_BROWSER_READY")
            expect_inactive_overlay_absent(page)
            save_browser_screenshot(page, artifact_dir, "session-chat-toggle-keeps-tui-active")

            page.locator('button[aria-label="Open settings"]:visible').first.click(timeout=30_000)
            settings_dialog = page.get_by_role("dialog").filter(has_text="Settings")
            expect(settings_dialog).to_be_visible(timeout=10_000)
            settings_dialog.get_by_label("Close").click(timeout=10_000)
            expect(settings_dialog).to_be_hidden(timeout=10_000)
            expect(page.locator(".terminal-panel").last).to_be_visible(timeout=10_000)
            expect_inactive_overlay_absent(page)
            save_browser_screenshot(page, artifact_dir, "session-settings-modal-does-not-detach")

            open_live_session(page, session_b)
            page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
            panel_b = page.locator(".terminal-panel").last
            expect(panel_b).to_be_visible(timeout=10_000)
            wait_for_terminal_text(panel_b, "RAH_NATIVE_CODEX_BROWSER_READY")

            open_live_session(page, session_a)
            page.get_by_role("button", name="TUI", exact=True).click(timeout=30_000)
            panel_a = page.locator(".terminal-panel").last
            expect(panel_a).to_be_visible(timeout=10_000)
            wait_for_terminal_text(panel_a, "RAH_NATIVE_CODEX_BROWSER_READY")
            expect_inactive_overlay_absent(page)
            save_browser_screenshot(page, artifact_dir, "session-switch-auto-reattaches-on-tui-open")

            page.get_by_label("Close Web TUI client").click(timeout=10_000)
            expect(page.get_by_test_id("terminal-client-inactive-overlay")).to_be_visible(
                timeout=10_000,
            )
            page.get_by_role("button", name="Activate TUI", exact=True).click(timeout=10_000)
            panel_a = page.locator(".terminal-panel").last
            expect(panel_a).to_be_visible(timeout=10_000)
            wait_for_terminal_text(panel_a, "RAH_NATIVE_CODEX_BROWSER_READY")
            save_browser_screenshot(page, artifact_dir, "manual-detach-reactivate")

            browser.close()

        print(
            json.dumps(
                {
                    "ok": True,
                    "baseUrl": base_url,
                    "sessionA": session_a,
                    "sessionB": session_b,
                    "browser": selected_browser_name(),
                    "headless": browser_headless(),
                    "caseIds": CASE_IDS,
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
                    "browser": selected_browser_name(),
                    "headless": browser_headless(),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 1
    finally:
        close_session_quietly(base_url, session_a)
        close_session_quietly(base_url, session_b)
        if daemon:
            terminate_process_tree(daemon)
        move_path_to_trash(tmp_root)


if __name__ == "__main__":
    raise SystemExit(main())
