from __future__ import annotations

import hashlib
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
    "PWA-GLOBAL-NOTICE-001",
    "PWA-TURN-CHANGE-PREVIEW-001",
    "COMPOSER-UNIFIED-SURFACE-001",
    "CHAT-MARKDOWN-IMAGES-001",
    "CHAT-VISUAL-OUTPUTS-001",
    "SIDEBAR-DENSITY-001",
    "CANVAS-SESSION-DROP-001",
]


SIDEBAR_VISUAL_METRICS_SCRIPT = """
surface => {
  const one = selector => surface.querySelector(selector);
  const round = value => Math.round(value * 100) / 100;
  const rect = element => element?.getBoundingClientRect() ?? null;
  const css = element => element ? getComputedStyle(element) : null;
  const px = value => round(Number.parseFloat(value || '0'));
  const centerDelta = (row, title) => {
    const rowRect = rect(row);
    const titleRect = rect(title);
    if (!rowRect || !titleRect) return null;
    return round(
      titleRect.top + titleRect.height / 2 -
      (rowRect.top + rowRect.height / 2)
    );
  };
  const surfaceRect = rect(surface);
  const surfaceStyle = css(surface);
  const surfaceRightEdge = surfaceRect
    ? surfaceRect.right - px(surfaceStyle?.borderRightWidth)
    : null;
  const header = one('.rah-sidebar-header-frame');
  const headerRect = rect(header);
  const headerStyle = css(header);
  const headerTitle = one('.rah-sidebar-header-title');
  const headerTitleRect = rect(headerTitle);
  const headerTitleStyle = css(headerTitle);
  const navigation = one('.rah-sidebar-primary-navigation');
  const navigationStyle = css(navigation);
  const firstNavigationRow = navigation?.querySelector('.rah-sidebar-navigation-item');
  const firstNavigationRect = rect(firstNavigationRow);
  const firstNavigationStyle = css(firstNavigationRow);
  const firstNavigationIcon = firstNavigationRow?.querySelector('svg');
  const firstNavigationIconRect = rect(firstNavigationIcon);
  const sectionLabel = one('[data-sidebar-section-label]');
  const sectionLabelStyle = css(sectionLabel);
  const workspaceRow = one('[data-sidebar-workspace-row="true"]');
  const workspaceRect = rect(workspaceRow);
  const workspaceStyle = css(workspaceRow);
  const workspaceTitle = workspaceRow?.querySelector('.rah-sidebar-workspace-title');
  const workspaceTitleStyle = css(workspaceTitle);
  const workspaceIcon = workspaceRow?.querySelector('svg');
  const workspaceIconRect = rect(workspaceIcon);
  const sessionRow = one('[data-sidebar-session-id]');
  const sessionRect = rect(sessionRow);
  const sessionStyle = css(sessionRow);
  const sessionTitle = sessionRow?.querySelector('.rah-sidebar-session-title');
  const sessionTitleStyle = css(sessionTitle);
  const actionCell = one('.rah-sidebar-action-cell');
  const actionCellRect = rect(actionCell);
  const rowListStyle = css(one('.rah-sidebar-row-list'));
  const workspaceListStyle = css(one('.rah-sidebar-workspace-list'));
  if (
    !surfaceRect || !headerRect || !headerTitleRect || !firstNavigationRect ||
    !firstNavigationIconRect || !workspaceRect || !workspaceIconRect ||
    !sessionRect || !actionCellRect
  ) return null;
  return {
    protocol: surface.getAttribute('data-sidebar-protocol'),
    header: {
      height: round(headerRect.height),
      borderBottom: px(headerStyle?.borderBottomWidth),
      titleOffsetLeft: round(headerTitleRect.left - surfaceRect.left),
      fontSize: px(headerTitleStyle?.fontSize),
      lineHeight: px(headerTitleStyle?.lineHeight),
      fontWeight: Number(headerTitleStyle?.fontWeight),
    },
    navigation: {
      topGap: round(firstNavigationRect.top - headerRect.bottom),
      insetLeft: round(firstNavigationRect.left - surfaceRect.left),
      insetRight: round(surfaceRightEdge - firstNavigationRect.right),
      rowHeight: round(firstNavigationRect.height),
      rowRadius: px(firstNavigationStyle?.borderRadius),
      rowGap: px(navigationStyle?.rowGap),
      itemGap: px(firstNavigationStyle?.columnGap),
      fontSize: px(firstNavigationStyle?.fontSize),
      lineHeight: px(firstNavigationStyle?.lineHeight),
      fontWeight: Number(firstNavigationStyle?.fontWeight),
      iconWidth: round(firstNavigationIconRect.width),
      iconHeight: round(firstNavigationIconRect.height),
    },
    sectionLabel: {
      fontSize: px(sectionLabelStyle?.fontSize),
      lineHeight: px(sectionLabelStyle?.lineHeight),
      fontWeight: Number(sectionLabelStyle?.fontWeight),
    },
    workspace: {
      insetLeft: round(workspaceRect.left - surfaceRect.left),
      insetRight: round(surfaceRightEdge - workspaceRect.right),
      height: round(workspaceRect.height),
      radius: px(workspaceStyle?.borderRadius),
      fontSize: px(workspaceTitleStyle?.fontSize),
      lineHeight: px(workspaceTitleStyle?.lineHeight),
      fontWeight: Number(workspaceTitleStyle?.fontWeight),
      iconWidth: round(workspaceIconRect.width),
      iconHeight: round(workspaceIconRect.height),
      titleCenterDelta: centerDelta(workspaceRow, workspaceTitle),
    },
    session: {
      insetLeft: round(sessionRect.left - surfaceRect.left),
      insetRight: round(surfaceRightEdge - sessionRect.right),
      height: round(sessionRect.height),
      radius: px(sessionStyle?.borderRadius),
      fontSize: px(sessionTitleStyle?.fontSize),
      lineHeight: px(sessionTitleStyle?.lineHeight),
      fontWeight: Number(sessionTitleStyle?.fontWeight),
      titleCenterDelta: centerDelta(sessionRow, sessionTitle),
    },
    lists: {
      rowGap: px(rowListStyle?.rowGap),
      workspaceGap: px(workspaceListStyle?.rowGap),
    },
    action: {
      width: round(actionCellRect.width),
      height: round(actionCellRect.height),
    },
  };
}
"""


EXPECTED_SIDEBAR_VISUAL_METRICS = {
    "protocol": "codex-compact-v1",
    "header": {
        "height": 40,
        "borderBottom": 0,
        "titleOffsetLeft": 48,
        "fontSize": 16,
        "lineHeight": 20,
        "fontWeight": 600,
    },
    "navigation": {
        "topGap": 4,
        "insetLeft": 8,
        "insetRight": 8,
        "rowHeight": 32,
        "rowRadius": 10,
        "rowGap": 2,
        "itemGap": 10,
        "fontSize": 15,
        "lineHeight": 20,
        "fontWeight": 500,
        "iconWidth": 18,
        "iconHeight": 18,
    },
    "sectionLabel": {
        "fontSize": 13,
        "lineHeight": 18,
        "fontWeight": 550,
    },
    "workspace": {
        "insetLeft": 8,
        "insetRight": 8,
        "height": 30,
        "radius": 10,
        "fontSize": 14,
        "lineHeight": 20,
        "fontWeight": 500,
        "iconWidth": 16,
        "iconHeight": 16,
        "titleCenterDelta": 0,
    },
    "session": {
        "insetLeft": 8,
        "insetRight": 8,
        "height": 30,
        "radius": 10,
        "fontSize": 14,
        "lineHeight": 20,
        "fontWeight": 450,
        "titleCenterDelta": 0,
    },
    "lists": {"rowGap": 2, "workspaceGap": 6},
    "action": {"width": 28, "height": 28},
}


def write_history_fixture(
    codex_home: pathlib.Path,
    workspace: pathlib.Path,
    provider_session_id: str,
    title: str,
    timestamp: str,
    originator: str,
) -> pathlib.Path:
    gallery_paths = [
        workspace / "rah-gallery-overview.svg",
        workspace / "rah-gallery-breakdown.svg",
        workspace / "rah-output-equity.svg",
        workspace / "rah-output-correlation.svg",
    ]
    gallery_colors = [
        ("#2563eb", "Overview"),
        ("#059669", "Breakdown"),
        ("#7c3aed", "Equity"),
        ("#ea580c", "Correlation"),
    ]
    for image_path, (color, label) in zip(gallery_paths, gallery_colors):
        image_path.write_text(
            "".join(
                [
                    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">',
                    '<rect width="640" height="360" fill="#f8fafc"/>',
                    f'<path d="M40 290 C130 250 190 275 265 190 S420 145 600 70" fill="none" stroke="{color}" stroke-width="10"/>',
                    f'<text x="40" y="55" font-family="system-ui" font-size="30" fill="#111827">{label}</text>',
                    "</svg>",
                ]
            ),
            encoding="utf-8",
        )
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
            "type": "event_msg",
            "payload": {"type": "context_compacted"},
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
                        "text": "压缩后继续核对真实文字边界，避免分隔行占用过多垂直空间。",
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
                "content": [
                    {
                        "type": "output_text",
                        "text": (
                            f"{title} answer\n\n"
                            f"![Overview]({gallery_paths[0]})\n\n"
                            f"![Breakdown]({gallery_paths[1]})\n\n"
                            f"资金曲线：[rah-output-equity.svg]({gallery_paths[2]})\n\n"
                            f"相关性图：[rah-output-correlation.svg]({gallery_paths[3]})"
                        ),
                    }
                ],
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


def write_turn_change_artifact(
    rah_home: pathlib.Path,
    provider_session_id: str,
) -> None:
    turn_id = f"workspace-lifecycle-{provider_session_id}"
    owner_id = f"provider:codex\0{provider_session_id}"
    changed_paths = [
        "src/pwa-turn-review.ts",
        *[f"src/reply-navigation-fixture-{index:02d}.ts" for index in range(1, 13)],
    ]

    def digest(value: str) -> str:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]

    turn_dir = (
        rah_home
        / "runtime-daemon"
        / "turn-artifacts"
        / digest(owner_id)
        / digest(turn_id)
    )
    turn_dir.mkdir(parents=True, exist_ok=True)
    changed_files: list[dict[str, Any]] = []
    manifest_files: list[dict[str, Any]] = []
    for index, changed_path in enumerate(changed_paths):
        diff_file = f"workspace-lifecycle-fixture-{index:02d}.diff"
        unified_diff = (
            f"diff --git a/{changed_path} b/{changed_path}\n"
            "new file mode 100644\n"
            "--- /dev/null\n"
            f"+++ b/{changed_path}\n"
            "@@ -0,0 +1 @@\n"
            f"+export const replyNavigationFixture{index} = true;\n"
        )
        (turn_dir / diff_file).write_text(unified_diff, encoding="utf-8")
        changed_files.append(
            {
                "path": changed_path,
                "additions": 1,
                "deletions": 0,
            }
        )
        manifest_files.append(
            {
                "path": changed_path,
                "diffFile": diff_file,
                "truncated": False,
            }
        )
    (turn_dir / "manifest.json").write_text(
        json.dumps(
            {
                "version": 2,
                "ownerId": owner_id,
                "turnId": turn_id,
                "capturedAt": "2026-07-31T10:00:01.000Z",
                "fileChanges": {
                    "files": changed_files,
                    "totalAdditions": len(changed_files),
                    "totalDeletions": 0,
                },
                "truncated": False,
                "files": manifest_files,
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )


def workspace_row(page, workspace: pathlib.Path):
    return page.locator(f'[data-workspace-dir="{workspace}"]')


def assert_compaction_geometry(compaction, expected: dict[str, Any], label: str) -> None:
    metrics = compaction.evaluate(
        """
        element => {
          const slot = element.closest('.assistant-process-compaction-slot');
          const next = slot?.nextElementSibling;
          if (!slot || !next) return null;
          const style = getComputedStyle(element);
          const slotStyle = getComputedStyle(slot);
          const nextStyle = getComputedStyle(next);
          const rect = element.getBoundingClientRect();
          return {
            height: Math.round(rect.height * 100) / 100,
            minHeight: style.minHeight,
            paddingTop: style.paddingTop,
            paddingBottom: style.paddingBottom,
            leadingMargin: slotStyle.marginTop,
            trailingMargin: nextStyle.marginTop,
          };
        }
        """
    )
    if metrics != expected:
        raise AssertionError(
            f"{label} context-compaction rhythm drifted: "
            f"expected={expected!r} actual={metrics!r}"
        )


def assert_latest_reply_start_navigation(
    page,
    artifact_dir: pathlib.Path,
    *,
    label: str,
    screenshot_name: str,
) -> None:
    container = page.locator(
        '[data-testid="chat-thread-scroll-container"]:visible'
    ).first
    final_answer = page.locator(".prose-chat-final:visible").last
    expect(container).to_be_visible(timeout=20_000)
    expect(final_answer).to_be_visible(timeout=20_000)
    file_changes_footer = page.locator(
        '[data-testid="conversation-turn-file-changes-footer"]:visible'
    ).last
    if file_changes_footer.count() > 0:
        file_changes_footer.click(timeout=10_000)
        expect(file_changes_footer).to_have_text("Collapse files", timeout=10_000)
    geometry = final_answer.evaluate(
        """
        element => {
          const row = element.closest('[data-feed-entry-key]');
          const container = element.closest(
            '[data-testid="chat-thread-scroll-container"]'
          );
          if (!row || !container) return null;
          const containerRect = container.getBoundingClientRect();
          const rowRect = row.getBoundingClientRect();
          const desiredOcclusion = 24;
          const desiredScrollTop = Math.max(
            0,
            Math.min(
              container.scrollHeight - container.clientHeight,
              container.scrollTop + rowRect.top - containerRect.top + desiredOcclusion,
            ),
          );
          container.scrollTop = desiredScrollTop;
          container.dispatchEvent(new Event('scroll', { bubbles: true }));
          const positionedRowRect = row.getBoundingClientRect();
          return {
            rowHeight: rowRect.height,
            viewportHeight: container.clientHeight,
            viewportOffset: positionedRowRect.top - containerRect.top,
          };
        }
        """
    )
    if geometry is None or geometry["viewportOffset"] > -20:
        raise AssertionError(
            f"{label} fixture could not occlude the latest reply start: {geometry!r}"
        )
    if geometry["rowHeight"] > geometry["viewportHeight"] - 24:
        raise AssertionError(
            f"{label} fixture no longer covers the short-reply regression: {geometry!r}"
        )

    latest_reply_button = page.get_by_role(
        "button", name="Read latest reply from start", exact=True
    )
    expect(latest_reply_button).to_be_visible(timeout=10_000)
    save_browser_screenshot(page, artifact_dir, screenshot_name)
    latest_reply_button.click(timeout=10_000)
    expect(latest_reply_button).to_have_count(0, timeout=10_000)

    aligned_offset = final_answer.evaluate(
        """
        element => {
          const row = element.closest('[data-feed-entry-key]');
          const container = element.closest(
            '[data-testid="chat-thread-scroll-container"]'
          );
          if (!row || !container) return null;
          return (
            row.getBoundingClientRect().top -
            container.getBoundingClientRect().top
          );
        }
        """
    )
    if aligned_offset is None or abs(aligned_offset) > 1:
        raise AssertionError(
            f"{label} latest-reply action did not align the mounted row: "
            f"offset={aligned_offset!r}"
        )


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


def assert_pwa_workbench_header_clear_of_notice(page, page_name: str) -> dict[str, float]:
    header = page.locator('[data-workbench-header]:visible').first
    expect(header).to_be_visible(timeout=10_000)
    metrics = header.evaluate(
        """
        element => {
          const notice = document.querySelector(
            '[data-workbench-callout-variant="pwa-compact"]'
          );
          if (!notice) return null;
          const headerRect = element.getBoundingClientRect();
          const noticeRect = notice.getBoundingClientRect();
          return {
            headerHeight: headerRect.height,
            headerBottom: headerRect.bottom,
            noticeTop: noticeRect.top,
            gap: noticeRect.top - headerRect.bottom,
          };
        }
        """
    )
    if metrics is None:
        raise AssertionError(f"{page_name} omitted its PWA header or recovery notice")
    if metrics["headerHeight"] != 40:
        raise AssertionError(
            f"{page_name} diverged from the shared 40px PWA header: {metrics!r}"
        )
    if metrics["gap"] < 3.5:
        raise AssertionError(
            f"PWA recovery notice overlaps {page_name} header divider: {metrics!r}"
        )
    return metrics


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
        write_turn_change_artifact(rah_home, parent_session_id)
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

            desktop_session_row = page.locator(
                '[data-sidebar-session-provider="codex"]'
            ).filter(has_text=parent_title).first
            expect(desktop_session_row).to_be_visible(timeout=10_000)
            desktop_sidebar_metrics = page.locator(
                '[data-sidebar-surface="desktop"]:visible'
            ).evaluate(SIDEBAR_VISUAL_METRICS_SCRIPT)
            if desktop_sidebar_metrics != EXPECTED_SIDEBAR_VISUAL_METRICS:
                raise AssertionError(
                    "Desktop sidebar diverged from codex-compact-v1: "
                    f"{desktop_sidebar_metrics!r}"
                )
            desktop_session_row.hover()
            page.wait_for_timeout(180)
            desktop_session_actions = desktop_session_row.evaluate(
                """
                element => {
                  const actionGroup = element.querySelector(
                    '.rah-sidebar-session-hover-actions'
                  );
                  const actionStyle = actionGroup
                    ? getComputedStyle(actionGroup)
                    : null;
                  const title = element.querySelector(
                    '.rah-sidebar-session-title'
                  );
                  const titleStyle = title ? getComputedStyle(title) : null;
                  const rowStyle = getComputedStyle(element);
                  const visibleActions = [...element.querySelectorAll(
                    '.coarse-pointer-action-target'
                  )].filter(action => {
                    const style = getComputedStyle(action);
                    return style.opacity !== '0' && style.pointerEvents !== 'none';
                  });
                  return {
                    hovered: element.matches(':hover'),
                    fineHover: matchMedia('(hover: hover) and (pointer: fine)').matches,
                    rowBackground: rowStyle.backgroundColor,
                    actionBackground: actionStyle?.backgroundColor ?? null,
                    actionShadow: actionStyle?.boxShadow ?? null,
                    visibleActionCountContract: element.getAttribute(
                      'data-sidebar-visible-action-count'
                    ),
                    titleActionCoverCount: element.getAttribute(
                      'data-sidebar-title-action-cover-count'
                    ),
                    titleActionCover: titleStyle?.getPropertyValue(
                      '--rah-sidebar-session-action-cover'
                    ).trim() ?? null,
                    titleMaskImage: titleStyle?.maskImage ?? null,
                    visibleActionCount: visibleActions.length,
                  };
                }
                """
            )
            if not desktop_session_actions["hovered"] or not desktop_session_actions["fineHover"]:
                raise AssertionError(
                    "Desktop Session action check did not run under a fine-pointer hover: "
                    f"{desktop_session_actions!r}"
                )
            if desktop_session_actions["rowBackground"] == "rgba(0, 0, 0, 0)":
                raise AssertionError(
                    "Desktop Session hover did not paint the shared row surface: "
                    f"{desktop_session_actions!r}"
                )
            if desktop_session_actions["actionBackground"] != "rgba(0, 0, 0, 0)":
                raise AssertionError(
                    "Desktop Session actions regained a separate background plate: "
                    f"{desktop_session_actions!r}"
                )
            if desktop_session_actions["actionShadow"] != "none":
                raise AssertionError(
                    "Desktop Session actions regained a separate shadow: "
                    f"{desktop_session_actions!r}"
                )
            if desktop_session_actions["visibleActionCount"] != 2:
                raise AssertionError(
                    "Desktop Session hover did not reveal both actions: "
                    f"{desktop_session_actions!r}"
                )
            if desktop_session_actions["visibleActionCountContract"] != "2":
                raise AssertionError(
                    "Desktop Session did not reserve both trailing actions: "
                    f"{desktop_session_actions!r}"
                )
            if desktop_session_actions["titleActionCoverCount"] != "2":
                raise AssertionError(
                    "Stopped desktop Session did not cover both overlapping actions: "
                    f"{desktop_session_actions!r}"
                )
            if desktop_session_actions["titleActionCover"] != "calc(28px + 28px)":
                raise AssertionError(
                    "Desktop Session title did not reserve a 56px action cover: "
                    f"{desktop_session_actions!r}"
                )
            if (
                "calc(100% - 56px)"
                not in desktop_session_actions["titleMaskImage"]
                or "calc(100% - 44px)"
                not in desktop_session_actions["titleMaskImage"]
            ):
                raise AssertionError(
                    "Desktop Session title did not fade below Pin and Archive: "
                    f"{desktop_session_actions!r}"
                )
            save_browser_screenshot(
                page,
                artifact_dir,
                "02a-desktop-session-actions-seamless",
            )

            desktop_session_tooltip = page.locator('[role="tooltip"]').filter(
                has_text=parent_title
            )
            expect(desktop_session_tooltip).to_be_visible(timeout=2_000)
            page.mouse.move(1_000, 700)
            expect(desktop_session_tooltip).to_have_count(0, timeout=1_000)

            desktop_session_row.hover()
            page.wait_for_timeout(40)
            page.locator("body").dispatch_event(
                "pointerdown",
                {"pointerType": "mouse", "button": 0, "buttons": 1},
            )
            page.wait_for_timeout(200)
            expect(desktop_session_tooltip).to_have_count(0)

            desktop_second_session_row = page.locator(
                '[data-sidebar-session-provider="codex"]'
            ).filter(has_text=child_title).first
            expect(desktop_second_session_row).to_be_visible(timeout=10_000)
            desktop_second_session_tooltip = page.locator(
                '[role="tooltip"]'
            ).filter(has_text=child_title)
            page.mouse.move(1_000, 700)
            desktop_session_row.hover()
            expect(desktop_session_tooltip).to_be_visible(timeout=2_000)
            desktop_second_session_row.hover()
            expect(desktop_session_tooltip).to_have_count(0, timeout=1_000)
            expect(desktop_second_session_tooltip).to_be_visible(timeout=2_000)
            expect(page.locator('[role="tooltip"]')).to_have_count(1)
            page.mouse.move(1_000, 700)
            expect(desktop_second_session_tooltip).to_have_count(0, timeout=1_000)

            page.get_by_role("button", name="Canvas", exact=True).click(
                timeout=10_000
            )
            stopped_session_drag_source = page.locator(
                '[data-sidebar-session-provider="codex"]'
            ).filter(has_text=parent_title).get_by_role(
                "button", name=parent_title, exact=True
            )
            expect(stopped_session_drag_source).to_have_attribute(
                "draggable", "true", timeout=10_000
            )
            canvas_first_pane = page.locator("[data-canvas-pane-id]").first
            expect(canvas_first_pane).to_be_visible(timeout=10_000)
            stopped_session_drag_source.drag_to(canvas_first_pane)
            expect(
                canvas_first_pane.get_by_text(parent_title, exact=True)
            ).to_be_visible(timeout=20_000)
            save_browser_screenshot(
                page,
                artifact_dir,
                "02b-desktop-canvas-stopped-session-drop",
            )
            page.get_by_role(
                "button", name="Close canvas view", exact=True
            ).click(timeout=10_000)

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
            desktop_new_surface = page.locator(
                '.rah-unified-composer[data-surface="new-task"]:visible'
            )
            desktop_workspace_strip = page.locator(
                '.rah-new-task-workspace-strip:visible'
            )
            desktop_provider_module = page.locator(
                '[data-provider-selector="module"]:visible'
            )
            desktop_new_task_metrics = page.evaluate(
                """
                () => {
                  const composer = document.querySelector(
                    '.rah-unified-composer[data-surface="new-task"]'
                  );
                  const strip = document.querySelector(
                    '.rah-new-task-workspace-strip'
                  );
                  const trigger = strip?.querySelector(
                    'button[aria-label="Select workspace"]'
                  );
                  const provider = document.querySelector(
                    '[data-provider-selector="module"]'
                  );
                  const selected = provider?.querySelector('[aria-checked="true"]');
                  const mode = composer?.querySelector('[data-composer-control="permissions"]');
                  const plan = composer?.querySelector('[data-composer-control="plan"]');
                  const model = composer?.querySelector('[data-composer-control="model"]');
                  const primary = composer?.querySelector('[aria-label="Start session"]');
                  if (!composer || !strip || !trigger || !provider || !selected) return null;
                  const composerRect = composer.getBoundingClientRect();
                  const stripRect = strip.getBoundingClientRect();
                  const triggerRect = trigger.getBoundingClientRect();
                  const selectedStyle = getComputedStyle(selected);
                  const selectedLabel = selected.querySelector(
                    '.provider-choice-label-text'
                  );
                  const markerStyle = selectedLabel
                    ? getComputedStyle(selectedLabel, '::after')
                    : null;
                  const modeLabel = mode?.querySelector('.rah-composer-permission-label');
                  const planLabel = plan?.querySelector('.rah-composer-plan-label');
                  const leadingControls = [mode, plan].filter(Boolean);
                  const controls = [...leadingControls, model, primary].filter(Boolean);
                  const controlRects = controls.map(node => node.getBoundingClientRect());
                  const modelRect = model?.getBoundingClientRect() ?? null;
                  const primaryRect = primary?.getBoundingClientRect() ?? null;
                  const leadingRight = leadingControls.length > 0
                    ? Math.max(...leadingControls.map(node => node.getBoundingClientRect().right))
                    : null;
                  return {
                    overlap: composerRect.bottom - stripRect.top,
                    stripHeight: stripRect.height,
                    triggerHeight: triggerRect.height,
                    providerHeight: provider.getBoundingClientRect().height,
                    selectedCount: provider.querySelectorAll('[aria-checked="true"]').length,
                    selectedBackground: selectedStyle.backgroundColor,
                    selectedBoxShadow: selectedStyle.boxShadow,
                    selectedFontWeight: selectedStyle.fontWeight,
                    selectedLabelWidth: selectedLabel?.getBoundingClientRect().width ?? null,
                    selectedMarkerWidth: markerStyle?.width ?? null,
                    selectedMarkerHeight: markerStyle?.height ?? null,
                    selectedMarkerOpacity: markerStyle?.opacity ?? null,
                    selectedMarkerBackground: markerStyle?.backgroundColor ?? null,
                    selectedButtonMarkerDisplay: getComputedStyle(
                      selected,
                      '::after'
                    ).display,
                    moduleBackground: getComputedStyle(provider).backgroundColor,
                    moduleBorderWidth: getComputedStyle(provider).borderTopWidth,
                    selectedProvider: selected.getAttribute('aria-label'),
                    planPresent: Boolean(plan),
                    modeLabelDisplay: modeLabel ? getComputedStyle(modeLabel).display : null,
                    planLabelDisplay: planLabel ? getComputedStyle(planLabel).display : null,
                    controlsSameRow: controlRects.length >= 3 &&
                      Math.max(...controlRects.map(rect => rect.top)) -
                        Math.min(...controlRects.map(rect => rect.top)) <= 1,
                    modelAfterLeading: Boolean(
                      modelRect && leadingRight !== null && modelRect.left >= leadingRight
                    ),
                    modelToPrimaryGap:
                      modelRect && primaryRect
                        ? primaryRect.left - modelRect.right
                        : null,
                  };
                }
                """
            )
            if desktop_new_task_metrics is None:
                raise AssertionError("Desktop New task accessory geometry is incomplete")
            if (
                abs(desktop_new_task_metrics["overlap"] - 8) > 1
                or abs(desktop_new_task_metrics["stripHeight"] - 40) > 1
                or abs(desktop_new_task_metrics["triggerHeight"] - 28) > 1
            ):
                raise AssertionError(
                    "Desktop workspace strip is not tucked under the composer: "
                    f"{desktop_new_task_metrics!r}"
                )
            if (
                desktop_new_task_metrics["selectedCount"] != 1
                or abs(desktop_new_task_metrics["providerHeight"] - 36) > 1
                or desktop_new_task_metrics["selectedBackground"]
                != "rgba(0, 0, 0, 0)"
                or desktop_new_task_metrics["selectedBoxShadow"] != "none"
                or desktop_new_task_metrics["selectedFontWeight"] != "600"
                or desktop_new_task_metrics["selectedLabelWidth"] is None
                or desktop_new_task_metrics["selectedMarkerWidth"] is None
                or abs(
                    float(desktop_new_task_metrics["selectedMarkerWidth"][:-2])
                    - desktop_new_task_metrics["selectedLabelWidth"]
                )
                > 1
                or desktop_new_task_metrics["selectedMarkerHeight"] != "2px"
                or desktop_new_task_metrics["selectedMarkerOpacity"] != "1"
                or desktop_new_task_metrics["selectedMarkerBackground"]
                == "rgba(0, 0, 0, 0)"
                or desktop_new_task_metrics["selectedButtonMarkerDisplay"] != "none"
                or desktop_new_task_metrics["moduleBorderWidth"] != "0px"
                or desktop_new_task_metrics["modeLabelDisplay"] == "none"
                or (
                    desktop_new_task_metrics["planPresent"]
                    and desktop_new_task_metrics["planLabelDisplay"] == "none"
                )
                or not desktop_new_task_metrics["controlsSameRow"]
                or not desktop_new_task_metrics["modelAfterLeading"]
                or desktop_new_task_metrics["modelToPrimaryGap"] is None
                or desktop_new_task_metrics["modelToPrimaryGap"] > 8
            ):
                raise AssertionError(
                    "Desktop provider/composer controls left the shared wide layout contract: "
                    f"{desktop_new_task_metrics!r}"
                )
            desktop_provider_module.hover()
            desktop_provider_hover_metrics = desktop_provider_module.evaluate(
                """
                element => {
                  const selected = element.querySelector('[aria-checked="true"]');
                  return {
                    moduleBackground: getComputedStyle(element).backgroundColor,
                    selectedBackground: selected
                      ? getComputedStyle(selected).backgroundColor
                      : null,
                  };
                }
                """
            )
            if (
                desktop_provider_hover_metrics["moduleBackground"]
                == "rgba(0, 0, 0, 0)"
                or desktop_provider_hover_metrics["selectedBackground"]
                != "rgba(0, 0, 0, 0)"
            ):
                raise AssertionError(
                    "Desktop provider hover must add only the grouped surface: "
                    f"{desktop_provider_hover_metrics!r}"
                )
            page.locator("h1:visible").hover()
            page.wait_for_timeout(180)
            desktop_provider_leave_background = desktop_provider_module.evaluate(
                "element => getComputedStyle(element).backgroundColor"
            )
            if desktop_provider_leave_background != "rgba(0, 0, 0, 0)":
                raise AssertionError(
                    "Desktop provider grouped hover surface persisted after pointer leave: "
                    f"{desktop_provider_leave_background!r}"
                )
            expect(desktop_new_surface).to_be_visible(timeout=10_000)
            expect(desktop_workspace_strip).to_be_visible(timeout=10_000)
            expect(desktop_provider_module).to_be_visible(timeout=10_000)
            save_browser_screenshot(page, artifact_dir, "03-new-task-workspace-selected")

            page.locator("button:visible").filter(has_text=parent_title).click(
                timeout=10_000
            )
            desktop_process_toggle = page.locator(
                '[data-testid="assistant-process-group-toggle"]'
            ).last
            expect(desktop_process_toggle).to_be_enabled(timeout=20_000)
            desktop_process_toggle.click(timeout=10_000)
            desktop_compaction = page.locator(
                '[data-testid="context-compaction-divider"]'
            ).last
            expect(desktop_compaction).to_be_visible(timeout=10_000)
            assert_compaction_geometry(
                desktop_compaction,
                {
                    "height": 24,
                    "minHeight": "24px",
                    "paddingTop": "0px",
                    "paddingBottom": "0px",
                    "leadingMargin": "2px",
                    "trailingMargin": "2px",
                },
                "Desktop",
            )
            desktop_gallery = page.locator(
                '[data-markdown-image-grid="true"]'
            ).last
            expect(desktop_gallery).to_be_visible(timeout=20_000)
            desktop_gallery_metrics = desktop_gallery.evaluate(
                """
                element => {
                  const style = getComputedStyle(element);
                  const previews = [...element.querySelectorAll('[data-testid="conversation-inline-image"]')];
                  const rects = previews.map(preview => preview.getBoundingClientRect());
                  const imageRects = [...element.querySelectorAll('.prose-chat-image-thumbnail')]
                    .map(image => image.getBoundingClientRect());
                  const finalAnswer = element.closest('.prose-chat-final');
                  const finalStyle = finalAnswer ? getComputedStyle(finalAnswer) : null;
                  return {
                    display: style.display,
                    flexWrap: style.flexWrap,
                    gap: style.gap,
                    count: previews.length,
                    sameRow: rects.length === 2 && Math.abs(rects[0].top - rects[1].top) <= 1,
                    maxHeight: Math.max(...imageRects.map(rect => rect.height)),
                    fontSize: finalStyle?.fontSize ?? null,
                    lineHeight: finalStyle?.lineHeight ?? null,
                    fontWeight: finalStyle?.fontWeight ?? null,
                  };
                }
                """
            )
            expected_gallery_metrics = {
                "display": "flex",
                "flexWrap": "wrap",
                "gap": "12px",
                "count": 2,
                "sameRow": True,
                "fontSize": "14px",
                "lineHeight": "22px",
                "fontWeight": "430",
            }
            for key, expected in expected_gallery_metrics.items():
                if desktop_gallery_metrics.get(key) != expected:
                    raise AssertionError(
                        "Desktop Markdown gallery contract drifted: "
                        f"expected={expected_gallery_metrics!r} actual={desktop_gallery_metrics!r}"
                    )
            if desktop_gallery_metrics["maxHeight"] > 160.5:
                raise AssertionError(
                    f"Desktop local thumbnail exceeded 160px: {desktop_gallery_metrics!r}"
                )
            desktop_output_gallery = page.locator(
                '[data-testid="conversation-visual-output-gallery"]'
            ).last
            expect(desktop_output_gallery).to_be_visible(timeout=20_000)
            expect(
                desktop_output_gallery.locator(
                    '[data-testid="conversation-inline-image"][data-image-state="ready"]'
                )
            ).to_have_count(2, timeout=20_000)
            desktop_output_rects = desktop_output_gallery.locator(
                '[data-testid="conversation-inline-image"]'
            ).evaluate_all(
                "elements => elements.map(element => element.getBoundingClientRect())"
            )
            if (
                len(desktop_output_rects) != 2
                or abs(desktop_output_rects[0]["top"] - desktop_output_rects[1]["top"]) > 1
                or max(rect["height"] for rect in desktop_output_rects) > 160.5
            ):
                raise AssertionError(
                    "Desktop visual outputs are not a compact two-up thumbnail row: "
                    f"{desktop_output_rects!r}"
                )
            save_browser_screenshot(
                page,
                artifact_dir,
                "03a-desktop-markdown-thumbnail-gallery",
            )
            assert_latest_reply_start_navigation(
                page,
                artifact_dir,
                label="Desktop",
                screenshot_name="03b-desktop-latest-reply-start-action",
            )

            page.locator('button[aria-label="Settings"]:visible').click(
                timeout=10_000
            )
            settings_dialog = page.get_by_role("dialog").filter(has_text="Settings")
            expect(settings_dialog).to_be_visible(timeout=10_000)
            settings_dialog.get_by_role(
                "button", name="Appearance", exact=True
            ).click(timeout=10_000)
            navigation_font_before = settings_dialog.get_by_role(
                "button", name="Appearance", exact=True
            ).evaluate("element => getComputedStyle(element).fontSize")
            ui_font_input = settings_dialog.get_by_role(
                "spinbutton", name="Conversation text size", exact=True
            )
            expect(ui_font_input).to_have_value("14")
            expect(ui_font_input).to_have_attribute("min", "12")
            expect(ui_font_input).to_have_attribute("max", "20")
            ui_font_input.fill("18")
            ui_font_input.press("Enter")
            expect(page.locator("html")).to_have_attribute("data-rah-ui-font-size", "18")
            expect(page.locator("html")).to_have_attribute("data-rah-code-font-size", "16")
            adjusted_type_metrics = page.locator(".prose-chat-final").last.evaluate(
                """
                element => {
                  const style = getComputedStyle(element);
                  return { fontSize: style.fontSize, lineHeight: style.lineHeight };
                }
                """
            )
            if adjusted_type_metrics != {"fontSize": "18px", "lineHeight": "26px"}:
                raise AssertionError(
                    f"Appearance UI font setting did not update the conversation: {adjusted_type_metrics!r}"
                )
            navigation_font_after = settings_dialog.get_by_role(
                "button", name="Appearance", exact=True
            ).evaluate("element => getComputedStyle(element).fontSize")
            if navigation_font_after != navigation_font_before:
                raise AssertionError(
                    "Conversation text size leaked into navigation UI: "
                    f"before={navigation_font_before!r} after={navigation_font_after!r}"
                )
            ui_font_input.fill("14")
            ui_font_input.press("Enter")
            settings_dialog.get_by_role("button", name="Close", exact=True).click(
                timeout=10_000
            )

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

            def force_runtime_generation_mismatch(route):
                response = route.fetch()
                payload = response.json()
                payload["webBuildId"] = "workspace-smoke-daemon-generation"
                headers = {
                    key: value
                    for key, value in response.headers.items()
                    if key.lower() not in {"content-length", "content-encoding"}
                }
                route.fulfill(
                    status=response.status,
                    headers=headers,
                    content_type="application/json",
                    body=json.dumps(payload),
                )

            pwa_page.route("**/api/runtime", force_runtime_generation_mismatch)
            pwa_page.goto(base_url, wait_until="domcontentloaded")
            pwa_notice = pwa_page.locator(
                '[data-workbench-callout-variant="pwa-compact"]'
            )
            expect(pwa_notice).to_be_visible(timeout=10_000)
            expect(pwa_notice).to_contain_text("Restart RAH to update")
            expect(pwa_notice).to_contain_text(
                "Restart it on the host, then refresh this page."
            )
            expect(
                pwa_notice.get_by_role("button", name="Mute today", exact=True)
            ).to_be_visible(timeout=10_000)
            expect(
                pwa_notice.get_by_role("button", name="Retry", exact=True)
            ).to_have_count(0)
            expect(
                pwa_notice.get_by_text(
                    "RAH daemon restart required", exact=False
                )
            ).to_have_count(0)
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
            pwa_new_surface = pwa_page.locator(
                '.rah-unified-composer[data-surface="new-task"][data-pwa="true"]'
            )
            expect(pwa_new_surface).to_be_visible(timeout=10_000)
            pwa_workspace_strip = pwa_page.locator(
                '.rah-new-task-workspace-strip:visible'
            )
            expect(pwa_workspace_strip).to_be_visible(timeout=10_000)
            trigger_box = pwa_workspace_trigger.bounding_box()
            surface_box = pwa_new_surface.bounding_box()
            strip_box = pwa_workspace_strip.bounding_box()
            if trigger_box is None or surface_box is None or strip_box is None:
                raise AssertionError("PWA workspace context omitted layout geometry")
            if trigger_box["width"] > 193:
                raise AssertionError(
                    f"PWA workspace control exceeded its bounded width: {trigger_box!r}"
                )
            workspace_overlap = surface_box["y"] + surface_box["height"] - strip_box["y"]
            if abs(workspace_overlap - 8) > 1:
                raise AssertionError(
                    "PWA workspace context is not tucked 8px under the composer: "
                    f"surface={surface_box!r} strip={strip_box!r} overlap={workspace_overlap!r}"
                )
            if abs(strip_box["height"] - 40) > 1 or abs(trigger_box["height"] - 28) > 1:
                raise AssertionError(
                    "PWA workspace accessory is not using the compact 40/28 geometry: "
                    f"strip={strip_box!r} trigger={trigger_box!r}"
                )
            workspace_layering = pwa_new_surface.evaluate(
                """
                element => {
                  const strip = element.parentElement?.querySelector(
                    '.rah-new-task-workspace-strip'
                  );
                  if (!strip) return null;
                  const stripRect = strip.getBoundingClientRect();
                  const surfaceStyle = getComputedStyle(element);
                  const stripStyle = getComputedStyle(strip);
                  const overlapOwner = document.elementFromPoint(
                    stripRect.left + 18,
                    stripRect.top + 4,
                  );
                  return {
                    surfaceZ: surfaceStyle.zIndex,
                    stripZ: stripStyle.zIndex,
                    composerOwnsOverlap:
                      overlapOwner === element || element.contains(overlapOwner),
                  };
                }
                """
            )
            if workspace_layering != {
                "surfaceZ": "2",
                "stripZ": "auto",
                "composerOwnsOverlap": True,
            }:
                raise AssertionError(
                    "PWA workspace accessory paints over the composer instead of beneath it: "
                    f"{workspace_layering!r}"
                )
            pwa_provider_module = pwa_page.locator(
                '[data-provider-selector="module"]:visible'
            )
            expect(pwa_provider_module).to_be_visible(timeout=10_000)
            pwa_provider_metrics = pwa_provider_module.evaluate(
                """
                element => {
                  const selected = element.querySelector('[aria-checked="true"]');
                  if (!selected) return null;
                  const selectedStyle = getComputedStyle(selected);
                  const markerStyle = getComputedStyle(selected, '::after');
                  const selectedLabel = selected.querySelector(
                    '.provider-choice-label-text'
                  );
                  const selectedLogo = selected.querySelector('svg, img');
                  return {
                    selectedCount: element.querySelectorAll('[aria-checked="true"]').length,
                    moduleHeight: element.getBoundingClientRect().height,
                    touch: element.getAttribute('data-touch'),
                    selectedBackground: selectedStyle.backgroundColor,
                    selectedBoxShadow: selectedStyle.boxShadow,
                    selectedFontWeight: selectedStyle.fontWeight,
                    selectedMarkerWidth: markerStyle.width,
                    selectedMarkerHeight: markerStyle.height,
                    selectedMarkerOpacity: markerStyle.opacity,
                    selectedMarkerBackground: markerStyle.backgroundColor,
                    selectedLabelDisplay: selectedLabel
                      ? getComputedStyle(selectedLabel).display
                      : null,
                    selectedLogoWidth: selectedLogo
                      ? selectedLogo.getBoundingClientRect().width
                      : null,
                    moduleBorderWidth: getComputedStyle(element).borderTopWidth,
                  };
                }
                """
            )
            if (
                pwa_provider_metrics is None
                or pwa_provider_metrics["selectedCount"] != 1
                or abs(pwa_provider_metrics["moduleHeight"] - 48) > 1
                or pwa_provider_metrics["touch"] != "true"
                or pwa_provider_metrics["selectedBackground"]
                != "rgba(0, 0, 0, 0)"
                or pwa_provider_metrics["selectedBoxShadow"] != "none"
                or pwa_provider_metrics["selectedFontWeight"] != "600"
                or pwa_provider_metrics["selectedMarkerWidth"] != "24px"
                or pwa_provider_metrics["selectedMarkerHeight"] != "2px"
                or pwa_provider_metrics["selectedMarkerOpacity"] != "1"
                or pwa_provider_metrics["selectedMarkerBackground"]
                == "rgba(0, 0, 0, 0)"
                or pwa_provider_metrics["selectedLabelDisplay"] != "none"
                or abs(pwa_provider_metrics["selectedLogoWidth"] - 22) > 1
                or pwa_provider_metrics["moduleBorderWidth"] != "0px"
            ):
                raise AssertionError(
                    "PWA provider selector is not a flat single-layer strip: "
                    f"{pwa_provider_metrics!r}"
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
                raise AssertionError("PWA workspace context caused horizontal overflow")
            pwa_new_control_metrics = pwa_new_surface.evaluate(
                """
                element => {
                  const mode = element.querySelector('[data-composer-control="permissions"]');
                  const plan = element.querySelector('[data-composer-control="plan"]');
                  const model = element.querySelector('[data-composer-control="model"]');
                  const primary = element.querySelector('[aria-label="Start session"]');
                  const toolbar = element.querySelector('.rah-composer-toolbar');
                  const modelMarquee = model?.querySelector('.rah-composer-model-label');
                  const modeLabel = mode?.querySelector('.rah-composer-permission-label');
                  const planLabel = plan?.querySelector('.rah-composer-plan-label');
                  const modeIcon = mode?.querySelector('svg');
                  const planIcon = plan?.querySelector('.rah-composer-plan-icon');
                  const planGlyph = plan?.querySelector('.rah-composer-plan-compact-glyph');
                  if (!mode || !model || !primary) return null;
                  const leadingControls = [mode, plan].filter(Boolean);
                  const controls = [...leadingControls, model, primary];
                  const boxes = controls.map(node => node.getBoundingClientRect());
                  const modelBox = model.getBoundingClientRect();
                  const primaryBox = primary.getBoundingClientRect();
                  const leadingRight = Math.max(
                    ...leadingControls.map(node => node.getBoundingClientRect().right)
                  );
                  const overlaps = (a, b) => !(
                    a.right <= b.left || b.right <= a.left ||
                    a.bottom <= b.top || b.bottom <= a.top
                  );
                  const centerDelta = (control, content) => {
                    if (!control || !content) return null;
                    const controlRect = control.getBoundingClientRect();
                    const contentRect = content.getBoundingClientRect();
                    return [
                      Math.abs(
                        controlRect.left + controlRect.width / 2 -
                          (contentRect.left + contentRect.width / 2)
                      ),
                      Math.abs(
                        controlRect.top + controlRect.height / 2 -
                          (contentRect.top + contentRect.height / 2)
                      ),
                    ];
                  };
                  return {
                    modelText: model.textContent?.trim() || '',
                    overlap: boxes.some((box, index) =>
                      boxes.slice(index + 1).some(other => overlaps(box, other))
                    ),
                    sameRow:
                      Math.max(...boxes.map(box => box.top)) -
                        Math.min(...boxes.map(box => box.top)) <= 1,
                    modeLabelDisplay: modeLabel ? getComputedStyle(modeLabel).display : null,
                    planLabelDisplay: planLabel ? getComputedStyle(planLabel).display : null,
                    modeIconClass: modeIcon?.getAttribute('class') || '',
                    modeSize: [mode.getBoundingClientRect().width, mode.getBoundingClientRect().height],
                    modeIconCenterDelta: centerDelta(mode, modeIcon),
                    planSize: plan
                      ? [plan.getBoundingClientRect().width, plan.getBoundingClientRect().height]
                      : null,
                    planIconDisplay: planIcon ? getComputedStyle(planIcon).display : null,
                    planGlyphDisplay: planGlyph ? getComputedStyle(planGlyph).display : null,
                    planGlyphText: planGlyph?.textContent?.trim() || '',
                    planGlyphCenterDelta: centerDelta(plan, planGlyph),
                    planPresent: Boolean(plan),
                    toolbarDisplay: toolbar ? getComputedStyle(toolbar).display : null,
                    modelAfterLeading: modelBox.left >= leadingRight,
                    modelToPrimaryGap: primaryBox.left - modelBox.right,
                    modelMarqueeState: modelMarquee?.getAttribute('data-marquee') ?? null,
                    modelWhiteSpace: modelMarquee
                      ? getComputedStyle(modelMarquee).whiteSpace
                      : null,
                  };
                }
                """
            )
            if pwa_new_control_metrics is None:
                raise AssertionError("PWA New task omitted an agent capability control")
            if (
                pwa_new_control_metrics["overlap"]
                or not pwa_new_control_metrics["sameRow"]
                or pwa_new_control_metrics["toolbarDisplay"] != "flex"
            ):
                raise AssertionError(
                    f"PWA New task controls are not a stable single row: {pwa_new_control_metrics!r}"
                )
            if (
                pwa_new_control_metrics["modeLabelDisplay"] != "none"
                or (
                    pwa_new_control_metrics["planPresent"]
                    and pwa_new_control_metrics["planLabelDisplay"] != "none"
                )
                or not pwa_new_control_metrics["modeIconClass"]
                or (
                    pwa_new_control_metrics["planPresent"]
                    and (
                        pwa_new_control_metrics["planIconDisplay"] != "none"
                        or pwa_new_control_metrics["planGlyphDisplay"] not in {"flex", "inline-flex"}
                        or pwa_new_control_metrics["planGlyphText"] != "P"
                    )
                )
                or pwa_new_control_metrics["modeSize"] != [40, 40]
                or (
                    pwa_new_control_metrics["planPresent"]
                    and pwa_new_control_metrics["planSize"] != [40, 40]
                )
                or any(
                    delta > 1
                    for delta in (pwa_new_control_metrics["modeIconCenterDelta"] or [])
                )
                or (
                    pwa_new_control_metrics["planPresent"]
                    and any(
                        delta > 1
                        for delta in (
                            pwa_new_control_metrics["planGlyphCenterDelta"] or []
                        )
                    )
                )
                or not pwa_new_control_metrics["modelAfterLeading"]
                or pwa_new_control_metrics["modelToPrimaryGap"] < 0
                or pwa_new_control_metrics["modelToPrimaryGap"] > 6
                or not pwa_new_control_metrics["modelText"]
                or pwa_new_control_metrics["modelMarqueeState"] not in {"true", "false"}
                or pwa_new_control_metrics["modelWhiteSpace"] != "nowrap"
            ):
                raise AssertionError(
                    "PWA New task did not compress the shared right-anchored composer rail: "
                    f"{pwa_new_control_metrics!r}"
                )
            pwa_plan_control = pwa_new_surface.locator(
                '[data-composer-control="plan"]'
            )
            if pwa_new_control_metrics["planPresent"]:
                if pwa_plan_control.get_attribute("aria-pressed") != "true":
                    pwa_plan_control.click(timeout=10_000)
                expect(pwa_plan_control).to_have_attribute("aria-pressed", "true")
                pwa_page.mouse.move(0, 0)
                pwa_page.wait_for_timeout(180)
                pwa_plan_active_metrics = pwa_plan_control.evaluate(
                    """
                    element => {
                      const probe = document.createElement('span');
                      probe.style.color = 'var(--app-resource-link)';
                      document.body.appendChild(probe);
                      const linkColor = getComputedStyle(probe).color;
                      probe.remove();
                      return {
                        color: getComputedStyle(element).color,
                        linkColor,
                        className: element.className,
                        dataPlanActive: element.getAttribute('data-plan-active'),
                        backgroundColor: getComputedStyle(element).backgroundColor,
                        boxShadow: getComputedStyle(element).boxShadow,
                        glyphWeight: getComputedStyle(
                          element.querySelector('.rah-composer-plan-compact-glyph')
                        ).fontWeight,
                      };
                    }
                    """
                )
                if (
                    int(pwa_plan_active_metrics["glyphWeight"]) < 700
                    or pwa_plan_active_metrics["color"]
                    != pwa_plan_active_metrics["linkColor"]
                    or pwa_plan_active_metrics["backgroundColor"] != "rgba(0, 0, 0, 0)"
                    or pwa_plan_active_metrics["boxShadow"] != "none"
                ):
                    raise AssertionError(
                        "PWA Plan selection is not the compact desktop text treatment: "
                        f"{pwa_plan_active_metrics!r}"
                    )
                pwa_plan_control.click(timeout=10_000)
            pwa_model_trigger = pwa_new_surface.locator(
                '[data-composer-control="model"]'
            )
            pwa_model_label = pwa_model_trigger.locator(
                '.rah-composer-model-label'
            )
            pwa_model_trigger.evaluate(
                "element => { element.style.maxWidth = '2.5rem'; }"
            )
            expect(pwa_model_label).to_have_attribute(
                "data-marquee", "true", timeout=10_000
            )
            pwa_model_trigger.evaluate(
                "element => { element.style.removeProperty('max-width'); }"
            )
            for provider_label in ("Claude", "OpenCode"):
                provider_radio = pwa_page.get_by_role(
                    "radio", name=provider_label, exact=True
                )
                provider_radio.click(timeout=10_000)
                expect(provider_radio).to_have_attribute("aria-checked", "true")
                expect(
                    pwa_new_surface.locator(
                        '[data-composer-control="plan"]'
                    )
                ).to_have_count(0)
                expect(
                    pwa_new_surface.locator(
                        '[data-composer-control="permissions"]'
                    )
                ).to_have_count(1)
                expect(
                    pwa_new_surface.locator(
                        '[data-composer-control="model"]'
                    )
                ).to_have_count(1)
            codex_provider_radio = pwa_page.get_by_role(
                "radio", name="Codex", exact=True
            )
            codex_provider_radio.click(timeout=10_000)
            expect(codex_provider_radio).to_have_attribute("aria-checked", "true")
            expect(
                pwa_new_surface.locator('[data-composer-control="plan"]')
            ).to_have_count(1, timeout=10_000)
            pwa_notice_metrics = pwa_notice.evaluate(
                """
                element => {
                  const host = element.closest('[data-workbench-notice-host]');
                  const composer = document.querySelector(
                    '.rah-unified-composer[data-surface="new-task"][data-pwa="true"]'
                  );
                  if (!host || !composer) return null;
                  const rect = element.getBoundingClientRect();
                  const hostRect = host.getBoundingClientRect();
                  const composerRect = composer.getBoundingClientRect();
                  const style = getComputedStyle(element);
                  const probe = document.createElement('span');
                  probe.style.position = 'fixed';
                  probe.style.pointerEvents = 'none';
                  probe.style.background = 'var(--app-bg)';
                  probe.style.border = '1px solid var(--app-border)';
                  document.body.appendChild(probe);
                  const probeStyle = getComputedStyle(probe);
                  const pageBackgroundColor = probeStyle.backgroundColor;
                  const neutralBorderColor = probeStyle.borderColor;
                  probe.remove();
                  const rgb = value => {
                    const components = (value.match(/[\\d.]+/g) || [])
                      .slice(0, 3)
                      .map(Number);
                    return value.startsWith('color(srgb')
                      ? components.map(component => component * 255)
                      : components;
                  };
                  const colorDistance = (left, right) => {
                    const a = rgb(left);
                    const b = rgb(right);
                    if (a.length !== 3 || b.length !== 3) return null;
                    return Math.sqrt(a.reduce(
                      (sum, component, index) => sum + ((component - b[index]) ** 2),
                      0,
                    ));
                  };
                  return {
                    height: rect.height,
                    backgroundColor: style.backgroundColor,
                    borderColor: style.borderColor,
                    pageBackgroundColor,
                    neutralBorderColor,
                    backgroundDistanceFromPage: colorDistance(
                      style.backgroundColor,
                      pageBackgroundColor,
                    ),
                    borderDistanceFromNeutral: colorDistance(
                      style.borderColor,
                      neutralBorderColor,
                    ),
                    borderRadius: style.borderRadius,
                    boxShadow: style.boxShadow,
                    insetLeft: rect.left - hostRect.left,
                    insetRight: hostRect.right - rect.right,
                    insetTop: rect.top - hostRect.top,
                    insetBottom: hostRect.bottom - rect.bottom,
                    overlapsComposer: rect.bottom > composerRect.top,
                  };
                }
                """
            )
            if pwa_notice_metrics is None:
                raise AssertionError("PWA recovery notice geometry is unavailable")
            if pwa_notice_metrics["height"] > 72:
                raise AssertionError(
                    f"PWA recovery notice exceeded 72px: {pwa_notice_metrics!r}"
                )
            if pwa_notice_metrics["backgroundColor"] == "rgb(255, 244, 219)":
                raise AssertionError(
                    "PWA recovery notice still uses the high-contrast warning surface: "
                    f"{pwa_notice_metrics!r}"
                )
            if pwa_notice_metrics["borderColor"] == "rgb(217, 119, 6)":
                raise AssertionError(
                    "PWA recovery notice still uses the high-contrast warning border: "
                    f"{pwa_notice_metrics!r}"
                )
            background_distance = pwa_notice_metrics["backgroundDistanceFromPage"]
            if background_distance is None or not 0 < background_distance <= 24:
                raise AssertionError(
                    "PWA recovery notice background is not a restrained page tint: "
                    f"{pwa_notice_metrics!r}"
                )
            border_distance = pwa_notice_metrics["borderDistanceFromNeutral"]
            if border_distance is None or not 0 < border_distance <= 48:
                raise AssertionError(
                    "PWA recovery notice border is not a restrained warning-neutral mix: "
                    f"{pwa_notice_metrics!r}"
                )
            if pwa_notice_metrics["borderRadius"] != "12px":
                raise AssertionError(
                    f"PWA recovery notice corner radius drifted: {pwa_notice_metrics!r}"
                )
            if pwa_notice_metrics["boxShadow"] != "none":
                raise AssertionError(
                    f"PWA recovery notice regained an intrusive shadow: {pwa_notice_metrics!r}"
                )
            for inset_name in ("insetLeft", "insetRight", "insetTop", "insetBottom"):
                if pwa_notice_metrics[inset_name] < 3.5:
                    raise AssertionError(
                        "PWA recovery notice host clips a corner: "
                        f"{pwa_notice_metrics!r}"
                    )
            if pwa_notice_metrics["overlapsComposer"]:
                raise AssertionError(
                    f"PWA recovery notice overlaps New task: {pwa_notice_metrics!r}"
                )
            pwa_permission_control = pwa_new_surface.locator(
                'button[data-composer-control="permissions"]'
            )
            expect(pwa_permission_control).to_be_visible(timeout=10_000)
            pwa_attach_control = pwa_new_surface.locator(
                'button[aria-label="Add a reference or attachment"]'
            )
            expect(pwa_attach_control).to_be_visible(timeout=10_000)
            composer_icon_script = """
                element => {
                  const icon = element.querySelector('svg');
                  const probe = document.createElement('span');
                  probe.style.position = 'fixed';
                  probe.style.color = 'var(--app-fg)';
                  document.body.appendChild(probe);
                  const expectedForeground = getComputedStyle(probe).color;
                  probe.remove();
                  return {
                    color: getComputedStyle(element).color,
                    expectedForeground,
                    width: icon?.getAttribute('width') || null,
                    strokeWidth: icon?.getAttribute('stroke-width') || null,
                  };
                }
            """
            pwa_attach_icon = pwa_attach_control.evaluate(composer_icon_script)
            pwa_permission_icon = pwa_permission_control.evaluate(composer_icon_script)
            if pwa_attach_icon != {
                "color": pwa_attach_icon["expectedForeground"],
                "expectedForeground": pwa_attach_icon["expectedForeground"],
                "width": "20",
                "strokeWidth": "1.75",
            }:
                raise AssertionError(
                    f"PWA composer add icon lost its visual weight: {pwa_attach_icon!r}"
                )
            if pwa_permission_icon["width"] != "15" or pwa_permission_icon["strokeWidth"] != "1.8":
                raise AssertionError(
                    "PWA composer permission icon does not use the shared ghost-control weight: "
                    f"{pwa_permission_icon!r}"
                )
            pwa_page.evaluate(
                "document.activeElement instanceof HTMLElement && document.activeElement.blur()"
            )
            pwa_new_idle = pwa_new_surface.evaluate(
                """
                element => {
                  const rect = element.getBoundingClientRect();
                  const style = getComputedStyle(element);
                  return {
                    width: rect.width,
                    left: rect.left,
                    borderColor: style.borderColor,
                    boxShadow: style.boxShadow,
                  };
                }
                """
            )
            pwa_new_surface.locator("textarea").focus()
            pwa_page.wait_for_timeout(220)
            pwa_new_focused = pwa_new_surface.evaluate(
                """
                element => {
                  const rect = element.getBoundingClientRect();
                  const style = getComputedStyle(element);
                  return {
                    width: rect.width,
                    left: rect.left,
                    borderColor: style.borderColor,
                    boxShadow: style.boxShadow,
                  };
                }
                """
            )
            if pwa_new_focused != pwa_new_idle:
                raise AssertionError(
                    "PWA New task composer changed geometry or emphasis on focus: "
                    f"idle={pwa_new_idle!r} focused={pwa_new_focused!r}"
                )
            save_browser_screenshot(
                pwa_page,
                artifact_dir,
                "03b-pwa-new-task-workspace-context",
            )

            pwa_page.locator('button[aria-label="Open sidebar"]:visible').click(
                timeout=10_000
            )
            expect(
                pwa_page.locator(
                    f'[data-workspace-dir="{workspace_root}"]:visible'
                )
            ).to_be_visible(timeout=10_000)
            pwa_sidebar_metrics = pwa_page.locator(
                '[data-sidebar-surface="pwa"]:visible'
            ).evaluate(SIDEBAR_VISUAL_METRICS_SCRIPT)
            if pwa_sidebar_metrics != EXPECTED_SIDEBAR_VISUAL_METRICS:
                raise AssertionError(
                    "PWA sidebar diverged from codex-compact-v1: "
                    f"{pwa_sidebar_metrics!r}"
                )
            if pwa_sidebar_metrics != desktop_sidebar_metrics:
                raise AssertionError(
                    "Desktop and PWA sidebar metrics drifted apart: "
                    f"desktop={desktop_sidebar_metrics!r} pwa={pwa_sidebar_metrics!r}"
                )
            save_browser_screenshot(
                pwa_page,
                artifact_dir,
                "03b-pwa-sidebar-codex-compact",
            )
            pwa_new_task_nav_metrics = pwa_page.locator(
                'button[aria-label="New task"]:visible'
            ).evaluate(
                """
                element => {
                  const probe = document.createElement('span');
                  probe.style.position = 'fixed';
                  probe.style.background = 'var(--rah-sidebar-row-hover-bg)';
                  element.appendChild(probe);
                  const expectedBackground = getComputedStyle(probe).backgroundColor;
                  probe.remove();
                  const style = getComputedStyle(element);
                  return {
                    background: style.backgroundColor,
                    expectedBackground,
                    outlineStyle: style.outlineStyle,
                  };
                }
                """
            )
            if pwa_new_task_nav_metrics != {
                "background": pwa_new_task_nav_metrics["expectedBackground"],
                "expectedBackground": pwa_new_task_nav_metrics["expectedBackground"],
                "outlineStyle": "none",
            }:
                raise AssertionError(
                    "PWA primary navigation selection diverged from the Session hover surface: "
                    f"{pwa_new_task_nav_metrics!r}"
                )
            pwa_page.get_by_role("button", name="Council", exact=True).click(
                timeout=10_000
            )
            council_header_metrics = assert_pwa_workbench_header_clear_of_notice(
                pwa_page,
                "Council",
            )
            pwa_page.locator('button[aria-label="Open sidebar"]:visible').click(
                timeout=10_000
            )
            pwa_page.get_by_role("button", name="Canvas", exact=True).click(
                timeout=10_000
            )
            canvas_header_metrics = assert_pwa_workbench_header_clear_of_notice(
                pwa_page,
                "Canvas",
            )
            if canvas_header_metrics != council_header_metrics:
                raise AssertionError(
                    "PWA Council and Canvas do not share one header/notice geometry: "
                    f"council={council_header_metrics!r} canvas={canvas_header_metrics!r}"
                )
            pwa_page.locator('button[aria-label="Open sidebar"]:visible').click(
                timeout=10_000
            )
            pwa_page.locator("button:visible").filter(
                has_text=parent_title
            ).click(timeout=10_000)
            session_header_metrics = assert_pwa_workbench_header_clear_of_notice(
                pwa_page,
                "Session Chat",
            )
            if session_header_metrics != council_header_metrics:
                raise AssertionError(
                    "PWA Session Chat, Council, and Canvas do not share one header/notice geometry: "
                    f"session={session_header_metrics!r} council={council_header_metrics!r}"
                )
            pwa_shell = pwa_page.locator(
                '.chat-thread-shell[data-chat-density="mobile"]'
            )
            expect(pwa_shell).to_be_visible(timeout=20_000)
            pwa_output_gallery = pwa_page.locator(
                '[data-testid="conversation-visual-output-gallery"]'
            ).last
            expect(pwa_output_gallery).to_be_visible(timeout=20_000)
            expect(
                pwa_output_gallery.locator(
                    '[data-testid="conversation-inline-image"][data-image-state="ready"]'
                )
            ).to_have_count(2, timeout=20_000)
            pwa_output_gallery.locator(
                '[data-testid="conversation-inline-image"]'
            ).first.click(timeout=10_000)
            pwa_output_viewer = pwa_page.locator(
                '[data-testid="inspector-file-viewer"]:visible'
            )
            expect(pwa_output_viewer).to_have_count(1, timeout=10_000)
            pwa_output_viewer.get_by_role(
                "button", name="Close", exact=True
            ).click(timeout=10_000)
            expect(pwa_output_viewer).to_have_count(0, timeout=10_000)
            expect(pwa_page.get_by_text("Inspector", exact=True)).to_have_count(
                0, timeout=10_000
            )
            pwa_turn_change_card = pwa_page.locator(
                '[data-testid="conversation-turn-file-changes"]'
            )
            expect(pwa_turn_change_card).to_be_visible(timeout=20_000)
            pwa_turn_file_button = pwa_turn_change_card.locator(
                'button[title^="Open "]'
            ).first
            pwa_turn_file_path = (
                pwa_turn_file_button.get_attribute("title") or ""
            ).removeprefix("Open ")
            pwa_turn_file_button.click(
                timeout=10_000
            )
            expect(
                pwa_page.get_by_text("Review this turn", exact=True)
            ).to_be_visible(timeout=10_000)
            expect(
                pwa_page.locator('[data-testid="inspector-file-viewer"]:visible')
            ).to_have_count(0, timeout=10_000)
            pwa_review_file_toggle = pwa_page.locator(
                'button[aria-controls="review-mobile-file-list"]:visible'
            )
            expect(pwa_review_file_toggle).to_contain_text(
                pathlib.PurePosixPath(pwa_turn_file_path).name,
                timeout=10_000,
            )
            expect(
                pwa_page.get_by_text("Inspector", exact=True)
            ).to_have_count(0, timeout=10_000)
            expect(
                pwa_page.locator('#review-mobile-file-list:visible')
            ).to_have_count(0, timeout=10_000)
            pwa_review_file_toggle.click(timeout=10_000)
            expect(
                pwa_page.locator('#review-mobile-file-list:visible')
            ).to_have_count(1, timeout=10_000)
            pwa_page.get_by_role(
                "button", name="Close review", exact=True
            ).click(timeout=10_000)
            expect(pwa_shell).to_be_visible(timeout=10_000)
            expect(
                pwa_page.get_by_text("Inspector", exact=True)
            ).to_have_count(0, timeout=10_000)

            pwa_turn_change_card.get_by_role(
                "button", name="审查本轮变动", exact=True
            ).click(timeout=10_000)
            expect(
                pwa_page.get_by_text("Review this turn", exact=True)
            ).to_be_visible(timeout=10_000)
            expect(
                pwa_page.locator('#review-mobile-file-list:visible')
            ).to_have_count(0, timeout=10_000)
            pwa_page.get_by_role(
                "button", name="Close review", exact=True
            ).click(timeout=10_000)
            expect(
                pwa_page.get_by_text("Review this turn", exact=True)
            ).to_have_count(0, timeout=10_000)
            expect(
                pwa_page.get_by_text("Inspector", exact=True)
            ).to_have_count(0, timeout=10_000)
            assert_latest_reply_start_navigation(
                pwa_page,
                artifact_dir,
                label="PWA",
                screenshot_name="03c-pwa-latest-reply-start-action",
            )
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
                "fontSize": "14px",
                "lineHeight": "22px",
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
            if pwa_final_metrics != {"fontSize": "14px", "lineHeight": "22px"}:
                raise AssertionError(
                    f"PWA final-answer type scale drifted: {pwa_final_metrics!r}"
                )

            process_toggle = pwa_page.locator(
                '[data-testid="assistant-process-group-toggle"]'
            ).last
            expect(process_toggle).to_be_enabled(timeout=10_000)

            def read_process_final_divider_gaps():
                return process_toggle.evaluate(
                    """
                    toggle => {
                      const group = toggle.closest('[data-testid="assistant-process-group"]');
                      const divider = group?.querySelector(
                        '[data-testid="assistant-process-final-divider"]'
                      );
                      const row = group?.closest('[data-feed-entry-key]');
                      const finalRoot = row?.nextElementSibling?.querySelector(
                        '.prose-chat-final'
                      );
                      if (!group || !divider || !finalRoot) {
                        return null;
                      }
                      const textRects = root => {
                        const pending = [root];
                        const rects = [];
                        while (pending.length > 0) {
                          const node = pending.shift();
                          if (node.nodeType === 3 && (node.textContent || '').trim()) {
                            const range = document.createRange();
                            range.selectNodeContents(node);
                            const rect = range.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0) {
                              rects.push({ top: rect.top, bottom: rect.bottom });
                            }
                            continue;
                          }
                          pending.push(...node.childNodes);
                        }
                        return rects;
                      };
                      const details = group.querySelector('.assistant-process-details');
                      const processTextRects = textRects(details || toggle);
                      const finalTextRects = textRects(finalRoot);
                      const previousText = processTextRects.sort(
                        (left, right) => right.bottom - left.bottom
                      )[0];
                      const nextText = finalTextRects.sort(
                        (left, right) => left.top - right.top
                      )[0];
                      if (!previousText || !nextText) {
                        return null;
                      }
                      const dividerRect = divider.getBoundingClientRect();
                      const dividerStyle = getComputedStyle(divider);
                      const borderWidth = Number.parseFloat(
                        dividerStyle.borderBottomWidth
                      ) || dividerRect.height;
                      const lineTop = details
                        ? dividerRect.bottom - borderWidth
                        : dividerRect.top;
                      return {
                        leading: lineTop - previousText.bottom,
                        trailing: nextText.top - dividerRect.bottom,
                      };
                    }
                    """
                )

            collapsed_divider_gaps = read_process_final_divider_gaps()
            if (
                collapsed_divider_gaps is None
                or abs(
                    collapsed_divider_gaps["leading"]
                    - collapsed_divider_gaps["trailing"]
                )
                > 1.5
            ):
                raise AssertionError(
                    "Collapsed process/final divider is not optically centered: "
                    f"{collapsed_divider_gaps!r}"
                )
            process_toggle.click(timeout=10_000)
            pwa_compaction = pwa_page.locator(
                '[data-testid="context-compaction-divider"]'
            ).last
            expect(pwa_compaction).to_be_visible(timeout=10_000)
            assert_compaction_geometry(
                pwa_compaction,
                {
                    "height": 28,
                    "minHeight": "28px",
                    "paddingTop": "2px",
                    "paddingBottom": "2px",
                    "leadingMargin": "4px",
                    "trailingMargin": "4px",
                },
                "PWA",
            )
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
                "fontSize": "14px",
                "lineHeight": "22px",
            }
            if pwa_process_metrics != expected_process_metrics:
                raise AssertionError(
                    "PWA process-message density contract drifted: "
                    f"expected={expected_process_metrics!r} actual={pwa_process_metrics!r}"
                )
            expanded_divider_gaps = read_process_final_divider_gaps()
            if (
                expanded_divider_gaps is None
                or abs(
                    expanded_divider_gaps["leading"]
                    - expanded_divider_gaps["trailing"]
                )
                > 1.5
            ):
                raise AssertionError(
                    "Expanded process/final divider is not optically centered: "
                    f"{expanded_divider_gaps!r}"
                )
            pwa_chat_surface = pwa_page.locator(
                '.rah-unified-composer[data-surface="chat"][data-pwa="true"]'
            )
            expect(pwa_chat_surface).to_be_visible(timeout=10_000)
            pwa_chat_textarea = pwa_chat_surface.locator(
                'textarea[aria-label="Message composer"]'
            )
            pwa_chat_textarea.evaluate("element => element.blur()")
            pwa_page.wait_for_timeout(220)

            def read_pwa_chat_composer_metrics():
                return pwa_chat_surface.evaluate(
                    """
                    element => {
                      const textarea = element.querySelector('textarea');
                      const secondary = element.querySelector('.rah-chat-composer-secondary');
                      const toolbar = element.querySelector('.rah-composer-toolbar');
                      const mode = element.querySelector('[data-composer-control="permissions"]');
                      const plan = element.querySelector('[data-composer-control="plan"]');
                      const model = element.querySelector('[data-composer-control="model"]');
                      const attach = element.querySelector('.rah-chat-composer-attach');
                      const primary = element.querySelector('.rah-chat-composer-primary');
                      if (!textarea || !secondary || !toolbar || !attach || !primary) return null;
                      const rect = element.getBoundingClientRect();
                      const textareaRect = textarea.getBoundingClientRect();
                      const attachRect = attach.getBoundingClientRect();
                      const primaryRect = primary.getBoundingClientRect();
                      const style = getComputedStyle(element);
                      const textareaStyle = getComputedStyle(textarea);
                      return {
                        width: rect.width,
                        height: rect.height,
                        left: rect.left,
                        borderColor: style.borderColor,
                        boxShadow: style.boxShadow,
                        secondaryDisplay: getComputedStyle(secondary).display,
                        toolbarDisplay: getComputedStyle(toolbar).display,
                        modelBeforePrimary: model
                          ? model.getBoundingClientRect().right <= primary.getBoundingClientRect().left
                          : null,
                        modelToPrimaryGap: model
                          ? primary.getBoundingClientRect().left - model.getBoundingClientRect().right
                          : null,
                        modeLabelDisplay: mode?.querySelector('.rah-composer-permission-label')
                          ? getComputedStyle(mode.querySelector('.rah-composer-permission-label')).display
                          : null,
                        planLabelDisplay: plan?.querySelector('.rah-composer-plan-label')
                          ? getComputedStyle(plan.querySelector('.rah-composer-plan-label')).display
                          : null,
                        attachSize: [attachRect.width, attachRect.height],
                        primarySize: [primaryRect.width, primaryRect.height],
                        primaryHitWidth: Number.parseFloat(
                          getComputedStyle(primary, '::after').width
                        ),
                        textareaHeight: textareaRect.height,
                        textareaClientHeight: textarea.clientHeight,
                        textareaScrollHeight: textarea.scrollHeight,
                        textareaOverflowY: textareaStyle.overflowY,
                        textareaWhiteSpace: textareaStyle.whiteSpace,
                        composerExpanded:
                          element.getAttribute('data-composer-expanded'),
                        modeDisabled: mode?.disabled ?? null,
                        planDisabled: plan?.disabled ?? null,
                        modelDisabled: model?.disabled ?? null,
                      };
                    }
                    """
                )

            pwa_chat_idle = read_pwa_chat_composer_metrics()
            if pwa_chat_idle is None:
                raise AssertionError("PWA Chat composer omitted required controls")
            if not 48 <= pwa_chat_idle["height"] <= 52:
                raise AssertionError(
                    f"PWA idle Chat composer is not a one-row pill: {pwa_chat_idle!r}"
                )
            if (
                pwa_chat_idle["attachSize"] != [36, 36]
                or pwa_chat_idle["primarySize"] != [36, 36]
                or pwa_chat_idle["primaryHitWidth"] < 44
            ):
                raise AssertionError(
                    "PWA idle Chat controls are not visually compact with a preserved hit area: "
                    f"{pwa_chat_idle!r}"
                )
            if pwa_chat_idle["secondaryDisplay"] != "none":
                raise AssertionError(
                    f"PWA idle Chat composer exposed expanded controls: {pwa_chat_idle!r}"
                )
            if pwa_chat_idle["textareaWhiteSpace"] != "nowrap":
                raise AssertionError(
                    f"PWA idle Chat draft is not folded to one line: {pwa_chat_idle!r}"
                )

            pwa_chat_input = pwa_chat_surface.locator(
                ".rah-chat-composer-input"
            )

            def assert_first_expansion_gesture_does_not_activate(
                control, pointer_id, label
            ):
                pwa_chat_input.evaluate(
                    """
                    (element, pointerId) => element.dispatchEvent(new PointerEvent(
                      'pointerdown',
                      {
                        bubbles: true,
                        cancelable: true,
                        composed: true,
                        pointerId,
                        pointerType: 'touch',
                        isPrimary: true,
                        button: 0,
                      },
                    ))
                    """,
                    pointer_id,
                )
                expect(pwa_chat_textarea).to_be_focused(timeout=10_000)
                expect(control).to_be_visible(timeout=10_000)
                dispatch_result = control.evaluate(
                    """
                    (element, pointerId) => {
                      element.dispatchEvent(new PointerEvent('pointerup', {
                        bubbles: true,
                        cancelable: true,
                        composed: true,
                        pointerId,
                        pointerType: 'touch',
                        isPrimary: true,
                        button: 0,
                      }));
                      const click = new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                        composed: true,
                        button: 0,
                        detail: 1,
                      });
                      const dispatched = element.dispatchEvent(click);
                      return {
                        defaultPrevented: click.defaultPrevented,
                        dispatched,
                      };
                    }
                    """,
                    pointer_id,
                )
                if dispatch_result != {
                    "defaultPrevented": True,
                    "dispatched": False,
                }:
                    raise AssertionError(
                        "The first collapsed PWA Composer gesture was allowed to "
                        f"click through to {label}: {dispatch_result!r}"
                    )

            pwa_model_control = pwa_chat_surface.locator(
                '[data-composer-control="model"]'
            )
            assert_first_expansion_gesture_does_not_activate(
                pwa_model_control, 701, "the model control"
            )
            expect(pwa_model_control).to_have_attribute("aria-expanded", "false")
            expect(
                pwa_page.get_by_role(
                    "dialog", name="Model and parameters", exact=True
                )
            ).to_have_count(0, timeout=10_000)
            pwa_page.mouse.click(4, 400)
            pwa_page.wait_for_timeout(120)

            pwa_context_control = pwa_chat_surface.locator(
                '[data-composer-control="context"]'
            )
            if pwa_context_control.count() > 0:
                assert_first_expansion_gesture_does_not_activate(
                    pwa_context_control, 702, "the context indicator"
                )
                pwa_context_control.dispatch_event(
                    "pointerenter", {"pointerId": 702, "pointerType": "touch"}
                )
                expect(
                    pwa_page.locator('[data-testid="composer-context-tooltip"]')
                ).to_have_count(0, timeout=10_000)
                pwa_page.mouse.click(4, 400)
                pwa_page.wait_for_timeout(120)

            pwa_chat_input.click(position={"x": 4, "y": 18}, timeout=10_000)
            expect(pwa_chat_textarea).to_be_focused(timeout=10_000)
            long_chat_draft = "\n".join(
                f"第 {index} 行用于验证 iOS 输入法下的 Composer 原位测量与有界增高。"
                for index in range(1, 15)
            )
            pwa_chat_textarea.fill(long_chat_draft)
            pwa_page.wait_for_timeout(260)
            pwa_chat_focused = read_pwa_chat_composer_metrics()
            if pwa_chat_focused is None:
                raise AssertionError("PWA focused Chat composer metrics are unavailable")
            if pwa_chat_focused["width"] < pwa_chat_idle["width"] + 24:
                raise AssertionError(
                    "PWA focused Chat composer did not expand horizontally: "
                    f"idle={pwa_chat_idle!r} focused={pwa_chat_focused!r}"
                )
            if pwa_chat_focused["height"] <= pwa_chat_idle["height"] + 24:
                raise AssertionError(
                    "PWA focused Chat composer did not reveal multiline input: "
                    f"idle={pwa_chat_idle!r} focused={pwa_chat_focused!r}"
                )
            if pwa_chat_focused["height"] > 340:
                raise AssertionError(
                    f"PWA focused Chat composer exceeded its height cap: {pwa_chat_focused!r}"
                )
            if (
                pwa_chat_focused["textareaHeight"] < 200
                or pwa_chat_focused["textareaScrollHeight"]
                <= pwa_chat_focused["textareaClientHeight"]
                or pwa_chat_focused["textareaOverflowY"] != "auto"
            ):
                raise AssertionError(
                    "PWA focused Chat composer did not grow to its cap and then scroll: "
                    f"{pwa_chat_focused!r}"
                )
            if (
                pwa_chat_focused["composerExpanded"] != "true"
                or pwa_chat_focused["modeDisabled"]
                or pwa_chat_focused["planDisabled"]
                or pwa_chat_focused["modelDisabled"]
            ):
                raise AssertionError(
                    "PWA focused Chat composer controls are not explicitly expanded and interactive: "
                    f"{pwa_chat_focused!r}"
                )
            if pwa_chat_focused["secondaryDisplay"] == "none":
                raise AssertionError(
                    f"PWA focused Chat composer hid session controls: {pwa_chat_focused!r}"
                )
            if pwa_chat_focused["modelBeforePrimary"] is False:
                raise AssertionError(
                    "PWA focused Chat model control is not immediately before the primary action: "
                    f"{pwa_chat_focused!r}"
                )
            if (
                pwa_chat_focused["modelToPrimaryGap"] is None
                or pwa_chat_focused["modelToPrimaryGap"] < 0
                or pwa_chat_focused["modelToPrimaryGap"] > 6
                or pwa_chat_focused["modeLabelDisplay"] != "none"
                or pwa_chat_focused["planLabelDisplay"] != "none"
            ):
                raise AssertionError(
                    "PWA focused Chat did not reuse the compact right-anchored control rail: "
                    f"{pwa_chat_focused!r}"
                )
            if (
                pwa_chat_focused["borderColor"] != pwa_chat_idle["borderColor"]
                or pwa_chat_focused["boxShadow"] != pwa_chat_idle["boxShadow"]
            ):
                raise AssertionError(
                    "PWA focused Chat composer changed its border or shadow emphasis: "
                    f"idle={pwa_chat_idle!r} focused={pwa_chat_focused!r}"
                )
            pwa_chat_surface.evaluate(
                """
                element => {
                  const root = element.closest('[style*="--workbench-keyboard-inset"]');
                  if (!root) throw new Error('Workbench keyboard inset owner is missing');
                  root.style.setProperty('--workbench-keyboard-inset', '240px');
                }
                """
            )
            pwa_page.wait_for_timeout(120)
            pwa_keyboard_safe_metrics = pwa_chat_surface.evaluate(
                """
                element => ({
                  composerBottom: element.getBoundingClientRect().bottom,
                  viewportHeight: window.innerHeight,
                  activeElementIsTextarea:
                    document.activeElement === element.querySelector('textarea'),
                })
                """
            )
            pwa_keyboard_gap = (
                pwa_keyboard_safe_metrics["viewportHeight"]
                - pwa_keyboard_safe_metrics["composerBottom"]
            )
            if (
                pwa_keyboard_gap < 247
                or pwa_keyboard_gap > 251
                or not pwa_keyboard_safe_metrics["activeElementIsTextarea"]
            ):
                raise AssertionError(
                    "PWA focused Chat composer is not held 8px above the visual keyboard inset: "
                    f"{pwa_keyboard_safe_metrics!r}"
                )
            pwa_chat_surface.evaluate(
                """
                element => element
                  .closest('[style*="--workbench-keyboard-inset"]')
                  ?.style.setProperty('--workbench-keyboard-inset', '0px')
                """
            )
            pwa_page.wait_for_timeout(120)
            save_browser_screenshot(
                pwa_page,
                artifact_dir,
                "03c-pwa-chat-composer-expanded",
            )

            pwa_mode_control = pwa_chat_surface.locator(
                '[data-composer-control="permissions"]'
            )
            expect(pwa_mode_control).to_be_enabled(timeout=10_000)
            previous_mode_title = pwa_mode_control.get_attribute("title")
            pwa_mode_control.click(timeout=10_000)
            expect(pwa_chat_textarea).to_be_focused(timeout=10_000)
            pwa_mode_listbox = pwa_page.get_by_role(
                "listbox", name="Session mode", exact=True
            )
            expect(pwa_mode_listbox).to_be_visible(timeout=10_000)
            alternate_mode = pwa_mode_listbox.locator(
                '[role="option"]:not([aria-selected="true"])'
            ).first
            expect(alternate_mode).to_be_visible(timeout=10_000)
            alternate_mode.click(timeout=10_000)
            expect(pwa_mode_listbox).to_have_count(0, timeout=10_000)
            expect(pwa_chat_textarea).to_be_focused(timeout=10_000)
            if pwa_mode_control.get_attribute("title") == previous_mode_title:
                raise AssertionError("PWA permission control did not apply its selection")

            pwa_plan_control = pwa_chat_surface.locator(
                '[data-composer-control="plan"]'
            )
            expect(pwa_plan_control).to_be_enabled(timeout=10_000)
            previous_plan_state = pwa_plan_control.get_attribute("aria-pressed")
            pwa_plan_control.click(timeout=10_000)
            expect(pwa_chat_textarea).to_be_focused(timeout=10_000)
            expect(pwa_plan_control).not_to_have_attribute(
                "aria-pressed", previous_plan_state, timeout=10_000
            )
            pwa_plan_control.click(timeout=10_000)
            expect(pwa_chat_textarea).to_be_focused(timeout=10_000)
            expect(pwa_plan_control).to_have_attribute(
                "aria-pressed", previous_plan_state, timeout=10_000
            )

            pwa_model_control = pwa_chat_surface.locator(
                '[data-composer-control="model"]'
            )
            expect(pwa_model_control).to_be_enabled(timeout=10_000)
            pwa_model_control.click(timeout=10_000)
            expect(pwa_chat_textarea).to_be_focused(timeout=10_000)
            expect(pwa_model_control).to_have_attribute("aria-expanded", "true")
            pwa_page.wait_for_timeout(220)
            pwa_chat_menu_open = read_pwa_chat_composer_metrics()
            if pwa_chat_menu_open is None:
                raise AssertionError("PWA Chat composer vanished while model menu was open")
            if (
                pwa_chat_menu_open["secondaryDisplay"] == "none"
                or abs(pwa_chat_menu_open["width"] - pwa_chat_focused["width"]) > 1
            ):
                raise AssertionError(
                    "PWA Chat composer collapsed while its model menu was open: "
                    f"focused={pwa_chat_focused!r} menu={pwa_chat_menu_open!r}"
                )
            pwa_model_dialog = pwa_page.get_by_role(
                "dialog", name="Model and parameters", exact=True
            )
            expect(pwa_model_dialog).to_be_visible(timeout=10_000)
            pwa_sol_model = pwa_model_dialog.locator("button").filter(
                has_text="gpt-5.6-sol"
            ).first
            if pwa_sol_model.count() > 0:
                pwa_sol_model.click(timeout=10_000)
                pwa_model_dialog.get_by_role(
                    "button", name="Medium", exact=True
                ).click(timeout=10_000)
                expect(pwa_chat_textarea).to_be_focused(timeout=10_000)
                expect(pwa_model_control).to_have_attribute(
                    "title", "gpt-5.6-sol / Medium", timeout=10_000
                )
            else:
                pwa_model_control.click(timeout=10_000)
                expect(pwa_chat_textarea).to_be_focused(timeout=10_000)

            pwa_attachment_control = pwa_chat_surface.locator(
                ".rah-chat-composer-attach"
            )
            pwa_attachment_control.click(timeout=10_000)
            expect(pwa_chat_textarea).to_be_focused(timeout=10_000)
            pwa_attachment_dialog = pwa_page.get_by_role(
                "dialog", name="Add to message", exact=True
            )
            expect(pwa_attachment_dialog).to_be_visible(timeout=10_000)
            pwa_attachment_dialog.get_by_role(
                "button", name="Close attachment menu", exact=True
            ).click(timeout=10_000)
            expect(pwa_attachment_dialog).to_have_count(0, timeout=10_000)
            expect(pwa_chat_textarea).to_be_focused(timeout=10_000)

            pwa_page.mouse.click(4, 400)
            pwa_page.wait_for_timeout(260)
            if pwa_chat_textarea.evaluate(
                "element => document.activeElement === element"
            ):
                raise AssertionError(
                    "PWA Chat composer kept the keyboard focus after an outside pointerdown"
                )
            pwa_chat_blurred = read_pwa_chat_composer_metrics()
            if pwa_chat_blurred is None:
                raise AssertionError("PWA blurred Chat composer metrics are unavailable")
            if abs(pwa_chat_blurred["width"] - pwa_chat_idle["width"]) > 1:
                raise AssertionError(
                    "PWA Chat composer did not restore its idle inset: "
                    f"idle={pwa_chat_idle!r} blurred={pwa_chat_blurred!r}"
                )
            if pwa_chat_blurred["height"] > 52:
                raise AssertionError(
                    "PWA blurred Chat composer did not fold a long draft: "
                    f"blurred={pwa_chat_blurred!r}"
                )
            if pwa_chat_blurred["textareaWhiteSpace"] != "nowrap":
                raise AssertionError(
                    f"PWA blurred Chat draft is not folded to one line: {pwa_chat_blurred!r}"
                )
            if pwa_page.evaluate(
                "document.documentElement.scrollWidth > document.documentElement.clientWidth"
            ):
                raise AssertionError("PWA Chat composer caused horizontal overflow")
            save_browser_screenshot(
                pwa_page,
                artifact_dir,
                "03c-pwa-conversation-density",
            )
            save_browser_screenshot(
                pwa_page,
                artifact_dir,
                "03d-pwa-chat-composer-folded-draft",
            )

            expect(pwa_notice).to_be_visible(timeout=10_000)
            pwa_notice.get_by_role(
                "button", name="Mute today", exact=True
            ).click(timeout=10_000)
            expect(pwa_notice).to_have_count(0, timeout=10_000)
            pwa_page.reload(wait_until="domcontentloaded")
            expect(pwa_notice).to_have_count(0, timeout=10_000)
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
                        "Desktop and PWA sidebars compute the same codex-compact-v1 header, typography, row, inset, gap, icon, action, and vertical-centering metrics.",
                        "Desktop Session hover actions reuse the row surface without a separate background plate or shadow, and long stopped titles fade beneath both Pin/Unpin and Archive slots.",
                        "Desktop Session tooltips have one owner: cross-row hover replaces the active card, leaving clears it, and pending timers cannot reopen it after a page pointerdown.",
                        "A stopped provider-history Session is a native draggable source and its stable provider identity fills the target Canvas pane without removing the Sidebar row.",
                        "Workspace New task selects that exact workspace in the composer.",
                        "Desktop and iOS PWA New task tuck a compact 40px workspace accessory 8px beneath the composer with the composer owning the overlap, use a 28px trigger, and keep long-name marquee bounded.",
                        "Desktop and touch New task provider modules stay borderless and item backgrounds stay transparent; Desktop selection uses a blue text-width marker, touch uses 48px targets with a blue 24x2 icon marker, and the single grouped pointer hover surface disappears after leave.",
                        "iOS PWA recovery notice keeps a low-contrast orange tint, shadow-free corners, and clear composer separation.",
                        "iOS PWA primary navigation selection reuses the Session hover surface without a focus outline.",
                        "iOS PWA Session Chat, Council, and Canvas share one 40px single-line header and keep recovery notices below the divider.",
                        "iOS PWA turn-file and shared turn-review flows close directly back to Chat without exposing a full-screen Inspector.",
                        "Desktop and iOS PWA share one right-anchored composer rail: model/effort stays beside Send, narrow containers replace permission/Plan labels with icons, unsupported provider Plan toggles stay hidden, and overflowing models marquee.",
                        "iOS PWA conversation copy uses the shared 12-20px conversation setting, 75% user bubbles, 12px turn gaps, and flat process text.",
                        "Desktop and iOS PWA show Read latest reply whenever the latest final-answer start is genuinely occluded, even when the final row itself fits the viewport; clicking aligns the mounted row exactly and removes the action.",
                        "Desktop context compaction uses a 24px row with 2px adjacent gaps, while iOS PWA retains its 28px row with 4px gaps.",
                        "Collapsed and expanded process/final dividers remain optically centered against the actual surrounding glyph bounds.",
                        "iOS PWA Chat uses a 48–52px idle pill with 36px visible controls and a preserved 44px hit area, then stays expanded for focus or open model menus.",
                        "iOS PWA permissions, Plan, model, and attachment controls preserve the active textarea editing session; only a true outside pointer releases it.",
                        "Mute today survives a full PWA reload while the forced Web/daemon generation mismatch remains active.",
                        "Desktop Markdown images and terminal visual outputs use distinct, lazy, two-up thumbnail galleries capped at 160px; PWA reuses the output gallery without exposing Inspector on close.",
                        "Appearance exposes only a persisted 12-20px Session/Council text setting, derives code size proportionally, updates conversation type immediately, and leaves navigation unchanged.",
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
