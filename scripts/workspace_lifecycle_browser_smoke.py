from __future__ import annotations

import json
import os
import pathlib
import tempfile
import time
import traceback
import uuid
from typing import Any

from playwright.sync_api import expect, sync_playwright

from native_codex_browser_smoke import (
    browser_artifact_dir,
    browser_headless,
    free_port,
    launch_browser,
    preflight_browser_runtime,
    request_json,
    save_browser_screenshot,
    selected_browser_name,
    start_daemon,
    write_fake_codex,
)
from native_smoke_process import terminate_process_tree
from safe_trash import move_path_to_trash


CASE_IDS = [
    "CODEX-CATALOG-ROOT-001",
    "WORKSPACE-LIFECYCLE-001",
    "WORKSPACE-PROJECTION-001",
    "WORKSPACE-EMPTY-RECOVERY-001",
    "WORKSPACE-NEW-TASK-001",
    "PWA-COMPOSER-WORKSPACE-PILL-001",
    "PWA-CONVERSATION-DENSITY-001",
]


def write_history_fixture(
    codex_home: pathlib.Path,
    workspace: pathlib.Path,
    provider_session_id: str,
    title: str,
    timestamp: str,
    originator: str,
) -> pathlib.Path:
    rollout_dir = codex_home / "sessions" / "2026" / "07" / "31"
    rollout_dir.mkdir(parents=True, exist_ok=True)
    rollout_path = rollout_dir / f"rollout-{timestamp.replace(':', '-')}-{provider_session_id}.jsonl"
    turn_id = f"workspace-lifecycle-{provider_session_id}"
    rows: list[dict[str, Any]] = [
        {
            "timestamp": timestamp,
            "type": "session_meta",
            "payload": {
                "id": provider_session_id,
                "cwd": str(workspace),
                "timestamp": timestamp,
                "originator": originator,
            },
        },
        {
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": {"type": "task_started", "turn_id": turn_id},
        },
        {
            "timestamp": timestamp,
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": title}],
            },
        },
        {
            "timestamp": timestamp,
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": "我会先量化消息宽度、字号、行高与 turn 间距，再验证每屏有效文字行数。",
                    }
                ],
                "phase": "commentary",
            },
        },
        {
            "timestamp": timestamp,
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": f"{title} answer"}],
                "phase": "final_answer",
            },
        },
        {
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": {"type": "task_complete", "turn_id": turn_id},
        },
    ]
    rollout_path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
        encoding="utf-8",
    )
    return rollout_path


def workspace_row(page, workspace: pathlib.Path):
    return page.locator(f'[data-workspace-dir="{workspace}"]')


def hover_workspace_header(page, workspace: pathlib.Path) -> None:
    workspace_row(page, workspace).locator(":scope > div").first.hover()


def add_workspace_from_home(
    page,
    workspace: pathlib.Path,
    *,
    parent: pathlib.Path | None = None,
) -> None:
    page.locator('button[aria-label="Add workspace"]:visible').first.click(timeout=15_000)
    dialog = page.get_by_role("dialog", name="Select workspace")
    expect(dialog).to_be_visible(timeout=10_000)
    search = dialog.locator('input[placeholder="Search folders…"]')
    if parent is not None:
        search.fill(parent.name)
        dialog.get_by_role("button", name=parent.name, exact=True).click(timeout=10_000)
        search.fill("")
    else:
        search.fill(workspace.name)
        dialog.get_by_role("button", name=workspace.name, exact=True).click(timeout=10_000)
    if parent is not None:
        dialog.get_by_role("button", name=workspace.name, exact=True).click(timeout=10_000)
    expect(
        dialog.get_by_text(f"Selected: {workspace}", exact=True)
    ).to_be_visible(timeout=10_000)
    dialog.get_by_role("button", name="Select", exact=True).click(timeout=10_000)
    expect(workspace_row(page, workspace)).to_have_count(1, timeout=30_000)


def remove_workspace(page, workspace: pathlib.Path) -> None:
    row = workspace_row(page, workspace)
    expect(row).to_have_count(1, timeout=10_000)
    hover_workspace_header(page, workspace)
    row.get_by_title("More", exact=True).click(timeout=10_000)
    row.get_by_role("button", name="Remove workspace", exact=True).click(timeout=10_000)
    expect(row).to_have_count(0, timeout=10_000)


def assert_workspace_session(
    page,
    workspace: pathlib.Path,
    title: str,
    *,
    visible: bool,
    timeout: int = 60_000,
) -> None:
    locator = workspace_row(page, workspace).get_by_text(title, exact=True)
    if visible:
        expect(locator).to_be_visible(timeout=timeout)
    else:
        expect(locator).to_have_count(0, timeout=timeout)


def assert_workspace_api(
    base_url: str,
    expected: list[pathlib.Path],
) -> None:
    response = request_json(base_url, "/api/sessions")
    actual = response.get("workspaceDirs")
    if not isinstance(actual, list):
        raise AssertionError(f"/api/sessions omitted workspaceDirs: {response}")
    expected_strings = [str(path) for path in expected]
    if actual != expected_strings:
        raise AssertionError(
            f"workspace order/state mismatch: expected={expected_strings!r} actual={actual!r}"
        )
    if len(actual) != len(set(actual)):
        raise AssertionError(f"workspace list contains duplicates: {actual!r}")


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
                },
                ensure_ascii=False,
                indent=2,
            ),
            file=os.sys.stderr,
        )
        return 1

    tmp_root = pathlib.Path(tempfile.mkdtemp(prefix="rah-workspace-lifecycle-browser-"))
    home_dir = pathlib.Path.home()
    workspace_root = pathlib.Path(
        tempfile.mkdtemp(prefix="rah-p0-workspace-", dir=home_dir)
    )
    child_workspace = workspace_root / "child"
    recovery_workspace = pathlib.Path(
        tempfile.mkdtemp(prefix="rah-p0-recovery-", dir=home_dir)
    )
    child_workspace.mkdir()
    rah_home = tmp_root / "rah-home"
    codex_home = tmp_root / "codex-home"
    fake_codex = tmp_root / "fake-codex.js"
    parent_session_id = str(uuid.uuid4())
    child_session_id = str(uuid.uuid4())
    parent_title = (
        "请分析 iOS PWA 消息气泡的留白与文字密度，"
        f"并优化每屏有效内容 {parent_session_id[:8]}"
    )
    child_title = f"P0_CHILD_SESSION_{child_session_id[:8]}"
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    artifact_dir = browser_artifact_dir("workspace-lifecycle-browser")
    daemon = None
    page_errors: list[str] = []
    screenshots: list[str] = []

    try:
        (codex_home / "sessions").mkdir(parents=True)
        write_fake_codex(fake_codex)
        write_history_fixture(
            codex_home,
            workspace_root,
            parent_session_id,
            parent_title,
            "2026-07-31T10:00:00.000Z",
            "Codex Desktop",
        )
        write_history_fixture(
            codex_home,
            child_workspace,
            child_session_id,
            child_title,
            "2026-07-31T10:01:00.000Z",
            "codex_work_desktop",
        )
        daemon = start_daemon(
            {
                "RAH_HOME": str(rah_home),
                "CODEX_HOME": str(codex_home),
                "RAH_CODEX_BINARY": str(fake_codex),
                "RAH_CODEX_APP_SERVER_TRANSPORT": "stdio",
                "MOCK_CODEX_SESSION_ID": str(uuid.uuid4()),
            },
            port,
        )

        with sync_playwright() as playwright:
            browser = launch_browser(playwright)
            page = browser.new_page(viewport={"width": 1440, "height": 960})
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.goto(base_url, wait_until="domcontentloaded")

            workspace_rows = page.locator("[data-workspace-dir]")
            expect(workspace_rows).to_have_count(0, timeout=15_000)
            assert_workspace_api(base_url, [])

            add_workspace_from_home(page, workspace_root)
            assert_workspace_api(base_url, [workspace_root])
            assert_workspace_session(page, workspace_root, parent_title, visible=True)
            assert_workspace_session(page, workspace_root, child_title, visible=True)
            save_browser_screenshot(page, artifact_dir, "01-parent-owns-nested-session")

            add_workspace_from_home(
                page,
                child_workspace,
                parent=workspace_root,
            )
            assert_workspace_api(base_url, [workspace_root, child_workspace])
            assert_workspace_session(page, workspace_root, parent_title, visible=True)
            assert_workspace_session(page, workspace_root, child_title, visible=False)
            assert_workspace_session(page, child_workspace, child_title, visible=True)
            save_browser_screenshot(page, artifact_dir, "02-most-specific-workspace-ownership")

            child_row = workspace_row(page, child_workspace)
            hover_workspace_header(page, child_workspace)
            child_row.get_by_role(
                "button",
                name="New task in workspace",
                exact=True,
            ).click(timeout=10_000)
            selected_workspace = page.locator(
                f'button[aria-label="Select workspace"][title="{child_workspace}"]'
            )
            expect(selected_workspace).to_be_visible(timeout=10_000)
            save_browser_screenshot(page, artifact_dir, "03-new-task-workspace-selected")

            pwa_context = browser.new_context(
                viewport={"width": 390, "height": 844},
                has_touch=True,
            )
            pwa_context.add_init_script(
                """
                Object.defineProperty(window.navigator, "standalone", {
                  configurable: true,
                  get: () => true,
                });
                """
            )
            pwa_page = pwa_context.new_page()
            pwa_page.on("pageerror", lambda error: page_errors.append(str(error)))
            pwa_page.goto(base_url, wait_until="domcontentloaded")
            pwa_workspace_trigger = pwa_page.locator(
                'button[aria-label="Select workspace"]:visible'
            )
            expect(pwa_workspace_trigger).to_be_visible(timeout=10_000)
            pwa_workspace_trigger.click(timeout=10_000)
            pwa_page.locator(
                f'button[title="{workspace_root}"]:visible'
            ).click(timeout=10_000)
            pwa_workspace_trigger = pwa_page.locator(
                f'button[aria-label="Select workspace"][title="{workspace_root}"]:visible'
            )
            expect(pwa_workspace_trigger).to_be_visible(timeout=10_000)
            pwa_marquee = pwa_workspace_trigger.locator(
                '.rah-marquee[data-marquee="true"]'
            )
            expect(pwa_marquee).to_have_count(1)
            trigger_box = pwa_workspace_trigger.bounding_box()
            send_box = pwa_page.locator(
                'button[aria-label="Start session"]:visible'
            ).bounding_box()
            if trigger_box is None or send_box is None:
                raise AssertionError("PWA composer controls omitted layout geometry")
            if not 87 <= trigger_box["width"] <= 89:
                raise AssertionError(
                    f"PWA workspace pill width drifted from 5.5rem: {trigger_box!r}"
                )
            if trigger_box["x"] + trigger_box["width"] > send_box["x"]:
                raise AssertionError(
                    "PWA workspace pill overlaps the Start session button: "
                    f"workspace={trigger_box!r} send={send_box!r}"
                )
            animation_name = pwa_marquee.locator(
                ".rah-marquee-track"
            ).evaluate("element => getComputedStyle(element).animationName")
            if animation_name != "rah-marquee-left":
                raise AssertionError(
                    f"PWA workspace marquee is not running: {animation_name!r}"
                )
            if pwa_page.evaluate(
                "document.documentElement.scrollWidth > document.documentElement.clientWidth"
            ):
                raise AssertionError("PWA workspace pill caused horizontal overflow")
            save_browser_screenshot(
                pwa_page,
                artifact_dir,
                "03b-pwa-new-task-workspace-pill",
            )

            pwa_page.locator('button[aria-label="Open sidebar"]:visible').click(
                timeout=10_000
            )
            expect(
                pwa_page.locator(
                    f'[data-workspace-dir="{workspace_root}"]:visible'
                )
            ).to_be_visible(timeout=10_000)
            pwa_page.locator("button:visible").filter(
                has_text=parent_title
            ).click(timeout=10_000)
            pwa_shell = pwa_page.locator(
                '.chat-thread-shell[data-chat-density="mobile"]'
            )
            expect(pwa_shell).to_be_visible(timeout=20_000)
            pwa_user_message = pwa_page.locator(
                '[data-testid="chat-user-message"]'
            ).last
            expect(pwa_user_message).to_be_visible(timeout=20_000)
            pwa_user_metrics = pwa_user_message.evaluate(
                """
                element => {
                  const text = element.querySelector('[data-testid="user-message-text"]');
                  const content = element.querySelector('.chat-user-message-content');
                  const actions = element.querySelector('.chat-user-message-actions');
                  const row = element.closest('[data-feed-entry-key]');
                  if (!text || !content || !actions || !row) {
                    return null;
                  }
                  const textStyle = getComputedStyle(text);
                  return {
                    fontSize: textStyle.fontSize,
                    lineHeight: textStyle.lineHeight,
                    maxWidth: getComputedStyle(content).maxWidth,
                    actionsDisplay: getComputedStyle(actions).display,
                    rowGap: Number.parseFloat(getComputedStyle(row).paddingBottom),
                  };
                }
                """
            )
            expected_user_metrics = {
                "fontSize": "16px",
                "lineHeight": "24px",
                "maxWidth": "75%",
                "actionsDisplay": "none",
                "rowGap": 12,
            }
            if pwa_user_metrics != expected_user_metrics:
                raise AssertionError(
                    "PWA user-message density contract drifted: "
                    f"expected={expected_user_metrics!r} actual={pwa_user_metrics!r}"
                )

            pwa_final_metrics = pwa_page.locator(
                ".prose-chat-final"
            ).last.evaluate(
                """
                element => {
                  const style = getComputedStyle(element);
                  return { fontSize: style.fontSize, lineHeight: style.lineHeight };
                }
                """
            )
            if pwa_final_metrics != {"fontSize": "16px", "lineHeight": "24px"}:
                raise AssertionError(
                    f"PWA final-answer type scale drifted: {pwa_final_metrics!r}"
                )

            process_toggle = pwa_page.locator(
                '[data-testid="assistant-process-group-toggle"]'
            ).last
            expect(process_toggle).to_be_enabled(timeout=10_000)
            process_toggle.click(timeout=10_000)
            pwa_process_message = pwa_page.locator(
                ".assistant-process-message"
            ).last
            expect(pwa_process_message).to_be_visible(timeout=10_000)
            pwa_process_metrics = pwa_process_message.evaluate(
                """
                element => {
                  const containerStyle = getComputedStyle(element);
                  const prose = element.querySelector('.prose-chat-process');
                  if (!prose) {
                    return null;
                  }
                  const proseStyle = getComputedStyle(prose);
                  return {
                    backgroundColor: containerStyle.backgroundColor,
                    borderRadius: containerStyle.borderRadius,
                    paddingTop: containerStyle.paddingTop,
                    fontSize: proseStyle.fontSize,
                    lineHeight: proseStyle.lineHeight,
                  };
                }
                """
            )
            expected_process_metrics = {
                "backgroundColor": "rgba(0, 0, 0, 0)",
                "borderRadius": "0px",
                "paddingTop": "0px",
                "fontSize": "16px",
                "lineHeight": "24px",
            }
            if pwa_process_metrics != expected_process_metrics:
                raise AssertionError(
                    "PWA process-message density contract drifted: "
                    f"expected={expected_process_metrics!r} actual={pwa_process_metrics!r}"
                )
            save_browser_screenshot(
                pwa_page,
                artifact_dir,
                "03c-pwa-conversation-density",
            )
            pwa_context.close()

            page.reload(wait_until="domcontentloaded")
            expect(workspace_rows).to_have_count(2, timeout=20_000)
            expect(workspace_row(page, workspace_root)).to_have_count(1)
            expect(workspace_row(page, child_workspace)).to_have_count(1)
            assert_workspace_api(base_url, [workspace_root, child_workspace])
            assert_workspace_session(page, workspace_root, parent_title, visible=True)
            assert_workspace_session(page, child_workspace, child_title, visible=True)

            remove_workspace(page, workspace_root)
            assert_workspace_api(base_url, [child_workspace])
            expect(page.get_by_text(parent_title, exact=True)).to_have_count(0, timeout=10_000)
            expect(workspace_row(page, child_workspace)).to_have_count(1)
            assert_workspace_session(page, child_workspace, child_title, visible=True)
            save_browser_screenshot(page, artifact_dir, "04-parent-removal-keeps-child")

            remove_workspace(page, child_workspace)
            assert_workspace_api(base_url, [])
            expect(workspace_rows).to_have_count(0, timeout=10_000)
            expect(page.get_by_text(child_title, exact=True)).to_have_count(0, timeout=10_000)

            add_workspace_from_home(page, recovery_workspace)
            assert_workspace_api(base_url, [recovery_workspace])
            expect(workspace_row(page, recovery_workspace)).to_have_count(1)
            page.reload(wait_until="domcontentloaded")
            expect(workspace_rows).to_have_count(1, timeout=20_000)
            expect(workspace_row(page, recovery_workspace)).to_have_count(1)
            assert_workspace_api(base_url, [recovery_workspace])
            save_browser_screenshot(page, artifact_dir, "05-empty-list-recovers")

            remove_workspace(page, recovery_workspace)
            assert_workspace_api(base_url, [])
            if page_errors:
                raise AssertionError(
                    f"browser page errors occurred during workspace lifecycle: {page_errors!r}"
                )
            browser.close()

        screenshots.extend(
            str(path.relative_to(pathlib.Path.cwd()))
            for path in sorted(artifact_dir.glob("*.png"))
            if path.is_relative_to(pathlib.Path.cwd())
        )
        print(
            json.dumps(
                {
                    "ok": True,
                    "baseUrl": base_url,
                    "browser": selected_browser_name(),
                    "headless": browser_headless(),
                    "caseIds": CASE_IDS,
                    "screenshots": screenshots,
                    "asserted": [
                        "An empty Workspaces list can add a workspace through the real picker.",
                        "Nested stored sessions move to the most-specific registered workspace.",
                        "User-owned Codex Desktop roots remain visible for both supported originators.",
                        "Workspace New task selects that exact workspace in the composer.",
                        "iOS PWA New task keeps an 88px workspace pill with an active marquee.",
                        "iOS PWA conversation copy uses 16/24 type, 75% user bubbles, 12px turn gaps, and flat process text.",
                        "Reload preserves workspace count, order, and unique rows.",
                        "Removing a parent hides its sessions immediately without hiding a registered child.",
                        "Removing the final workspace hides its sessions without requiring reload.",
                        "A workspace can be added again after the list becomes empty.",
                        "No browser page errors occur during the lifecycle.",
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except Exception as exc:
        try:
            if "page" in locals():
                save_browser_screenshot(page, artifact_dir, "failure")
        except Exception:
            pass
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": str(exc),
                    "traceback": traceback.format_exc(),
                    "baseUrl": base_url,
                    "browser": selected_browser_name(),
                    "headless": browser_headless(),
                    "caseIds": CASE_IDS,
                    "pageErrors": page_errors,
                    "artifactDir": str(artifact_dir),
                },
                ensure_ascii=False,
                indent=2,
            ),
            file=os.sys.stderr,
        )
        return 1
    finally:
        if daemon is not None:
            terminate_process_tree(daemon)
        for path in (workspace_root, recovery_workspace, tmp_root):
            try:
                move_path_to_trash(path)
            except Exception as exc:
                print(
                    f"workspace lifecycle smoke cleanup failed for {path}: {exc}",
                    file=os.sys.stderr,
                )


if __name__ == "__main__":
    raise SystemExit(main())
