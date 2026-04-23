from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
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
    with request.urlopen(req, timeout=240) as response:
        body = response.read()
        return json.loads(body) if body else {}


def close_live_sessions(base_url: str) -> None:
    sessions = request_json(base_url, "/api/sessions").get("sessions", [])
    for session in sessions:
        summary = session.get("session") if isinstance(session, dict) else None
        if not isinstance(summary, dict):
            continue
        session_id = summary.get("id")
        if not isinstance(session_id, str):
            continue
        client_id = None
        lease = session.get("controlLease") if isinstance(session, dict) else None
        if isinstance(lease, dict) and isinstance(lease.get("holderClientId"), str):
            client_id = lease["holderClientId"]
        if client_id is None:
            attached_clients = session.get("attachedClients") if isinstance(session, dict) else None
            if isinstance(attached_clients, list):
                for attached in attached_clients:
                    if isinstance(attached, dict) and isinstance(attached.get("id"), str):
                        client_id = attached["id"]
                        break
        if client_id is None:
            client_id = "inspector-browser-smoke"
        try:
            request_json(base_url, f"/api/sessions/{session_id}/close", {"clientId": client_id})
        except Exception:
            continue


def git(cwd: str, *args: str) -> None:
    subprocess.check_call(["git", *args], cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def build_workspace() -> str:
    repo = tempfile.mkdtemp(prefix="rah-inspector-browser-")
    git(repo, "init")
    git(repo, "config", "user.name", "RAH Browser Test")
    git(repo, "config", "user.email", "rah-browser@example.com")

    write_text(Path(repo) / "src/rename_before.rs", "pub fn renamed() {}\n")
    write_text(Path(repo) / "src/dual_stage.rs", 'pub fn dual() {\n    println!("base");\n}\n')
    Path(repo, "src").mkdir(parents=True, exist_ok=True)
    Path(repo, "src/blob.bin").write_bytes(bytes([0, 1, 2, 3, 4]))
    write_text(
        Path(repo) / "src/large_diff.rs",
        "".join(f'pub const LINE_{i}: &str = "old {i}";\n' for i in range(1, 901)),
    )
    git(repo, "add", ".")
    git(repo, "commit", "-m", "base")

    git(repo, "mv", "src/rename_before.rs", "src/rename_after.rs")
    write_text(Path(repo) / "src/dual_stage.rs", 'pub fn dual() {\n    println!("staged");\n}\n')
    git(repo, "add", "--", "src/dual_stage.rs")
    write_text(
        Path(repo) / "src/dual_stage.rs",
        'pub fn dual() {\n    println!("staged");\n    println!("unstaged");\n}\n',
    )
    Path(repo, "src/blob.bin").write_bytes(bytes([9, 8, 7, 6, 5, 4]))
    write_text(
        Path(repo) / "src/large_diff.rs",
        "".join(f'pub const LINE_{i}: &str = "new {i}";\n' for i in range(1, 901)),
    )
    return repo


def assert_dialog_contains(dialog, needle: str, *, timeout_ms: int = 10_000) -> None:
    started = time.time()
    while (time.time() - started) * 1000 < timeout_ms:
        if needle in dialog.inner_text():
            return
        dialog.page.wait_for_timeout(300)
    raise AssertionError(f"Dialog did not contain {needle!r}. Actual: {dialog.inner_text()[:2000]}")


def wait_for_file_preview_tokens(dialog, tokens: list[str], *, timeout_ms: int = 10_000) -> None:
    started = time.time()
    while (time.time() - started) * 1000 < timeout_ms:
        text = dialog.inner_text()
        if "Loading file…" not in text and all(token in text for token in tokens):
            return
        dialog.page.wait_for_timeout(300)
    raise AssertionError(
        f"File preview did not contain expected tokens {tokens!r}. Actual: {dialog.inner_text()[:2000]}"
    )


def assert_dialog_is_mobile_fullscreen(page, dialog) -> None:
    metrics = page.evaluate(
        """(node) => {
            if (!(node instanceof HTMLElement)) {
              return null;
            }
            const rect = node.getBoundingClientRect();
            return {
              width: rect.width,
              height: rect.height,
              top: rect.top,
              left: rect.left,
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
            };
        }""",
        dialog.element_handle(),
    )
    if not isinstance(metrics, dict):
        raise AssertionError("Could not read dialog metrics.")
    if metrics["left"] > 1 or metrics["top"] > 1:
        raise AssertionError(f"Expected fullscreen dialog origin, got {metrics}.")
    if metrics["width"] < metrics["viewportWidth"] - 4:
        raise AssertionError(f"Expected fullscreen dialog width, got {metrics}.")
    if metrics["height"] < metrics["viewportHeight"] - 24:
        raise AssertionError(f"Expected fullscreen dialog height, got {metrics}.")


def select_workspace_for_inspector(page, workspace: str, *, mobile: bool) -> None:
    workspace_name = Path(workspace).name
    if mobile:
        page.get_by_role("button", name="Open sidebar").click()
        sidebar_scope = page.locator('[role="dialog"]').last
    else:
        sidebar_scope = page.locator("aside").first
    sidebar_scope.get_by_text(workspace_name).first.click()
    page.wait_for_timeout(400)
    if mobile:
        if page.get_by_role("button", name="Open inspector").count() > 0:
            page.get_by_role("button", name="Open inspector").click()
    else:
        if page.get_by_role("button", name="Expand inspector").count() > 0:
            page.get_by_role("button", name="Expand inspector").click()


def main() -> int:
    base_url = os.environ.get("RAH_BASE_URL", "http://127.0.0.1:43111")
    workspace = build_workspace()
    result: dict[str, Any] = {"baseUrl": base_url, "workspace": workspace}

    try:
        close_live_sessions(base_url)
        request_json(base_url, "/api/workspaces/add", {"dir": workspace})
        request_json(base_url, "/api/workspaces/select", {"dir": workspace})

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1600, "height": 1100})
            page = context.new_page()
            page.goto(base_url, wait_until="domcontentloaded")
            expect(page.get_by_text("What would you like to build?")).to_be_visible(timeout=30_000)
            select_workspace_for_inspector(page, workspace, mobile=False)
            expect(page.get_by_text("Inspector", exact=True)).to_be_visible(timeout=90_000)

            def click_change(section_title: str, file_text: str):
                section = page.get_by_text(section_title, exact=True).locator("xpath=..")
                section.locator("button").filter(has_text=file_text).first.click()
                return page.locator('[role="dialog"]').last

            rename_dialog = click_change("Staged Changes (2)", "src/rename_after.rs")
            expect(rename_dialog.get_by_text("Staged", exact=True)).to_be_visible(timeout=10_000)
            assert_dialog_contains(rename_dialog, "src/rename_before.rs -> src/rename_after.rs")
            rename_dialog.get_by_label("Close").click()
            result["rename"] = "ok"

            binary_dialog = click_change("Unstaged Changes (3)", "src/blob.bin")
            expect(binary_dialog.get_by_text("Binary", exact=True)).to_be_visible(timeout=10_000)
            assert_dialog_contains(binary_dialog, "Binary files a/src/blob.bin and b/src/blob.bin differ")
            binary_dialog.get_by_label("Close").click()
            result["binary"] = "ok"

            staged_dialog = click_change("Staged Changes (2)", "src/dual_stage.rs")
            expect(staged_dialog.get_by_text("Staged", exact=True)).to_be_visible(timeout=10_000)
            staged_dialog.get_by_label("Close").click()

            unstaged_dialog = click_change("Unstaged Changes (3)", "src/dual_stage.rs")
            expect(unstaged_dialog.get_by_text("Unstaged", exact=True)).to_be_visible(timeout=10_000)
            unstaged_dialog.get_by_label("Close").click()
            result["dualStage"] = "ok"

            large_dialog = click_change("Unstaged Changes (3)", "src/large_diff.rs")
            expect(large_dialog.get_by_role("button", name="Load 400 more")).to_be_visible(timeout=10_000)
            page.wait_for_timeout(2500)
            large_dialog.get_by_role("button", name="Load 400 more").click()
            large_dialog.get_by_role("button", name="Wrap").click()
            large_dialog.get_by_label("Close").click()
            result["largeDiff"] = "ok"

            page.get_by_role("button", name="Files", exact=True).click()
            page.get_by_placeholder("Search files").fill("rename_after")
            page.locator("button").filter(has_text="rename_after.rs").first.click()
            file_dialog = page.locator('[role="dialog"]').last
            assert_dialog_contains(file_dialog, "rename_after.rs")
            wait_for_file_preview_tokens(file_dialog, ["pub"])
            file_dialog.get_by_label("Close").click()
            result["filesPreview"] = "ok"

            mobile_context = browser.new_context(
                viewport={"width": 390, "height": 844},
                is_mobile=True,
                has_touch=True,
            )
            mobile_page = mobile_context.new_page()
            mobile_page.goto(base_url, wait_until="domcontentloaded")
            expect(mobile_page.get_by_text("What would you like to build?")).to_be_visible(timeout=30_000)
            select_workspace_for_inspector(mobile_page, workspace, mobile=True)
            expect(mobile_page.get_by_text("Inspector", exact=True)).to_be_visible(timeout=30_000)
            mobile_page.get_by_role("button", name=re.compile(r"^Changes")).click()
            mobile_page.get_by_text("Unstaged Changes (3)", exact=True).locator("xpath=..").locator("button").filter(has_text="src/large_diff.rs").first.click()
            mobile_dialog = mobile_page.locator('[role="dialog"]').last
            expect(mobile_dialog.get_by_role("button", name="Load 400 more")).to_be_visible(timeout=10_000)
            assert_dialog_is_mobile_fullscreen(mobile_page, mobile_dialog)
            mobile_dialog.get_by_label("Close").click()
            result["mobileInspectorDialog"] = "ok"

            split_context = browser.new_context(
                viewport={"width": 694, "height": 1112},
                has_touch=True,
            )
            split_page = split_context.new_page()
            split_page.goto(base_url, wait_until="domcontentloaded")
            expect(split_page.get_by_text("What would you like to build?")).to_be_visible(timeout=30_000)
            select_workspace_for_inspector(split_page, workspace, mobile=True)
            expect(split_page.get_by_text("Inspector", exact=True)).to_be_visible(timeout=30_000)
            expect(split_page.get_by_role("button", name=re.compile(r"^Changes"))).to_be_visible(timeout=30_000)
            expect(split_page.get_by_role("button", name="Files", exact=True)).to_be_visible(timeout=30_000)
            split_page.get_by_role("button", name=re.compile(r"^Changes")).click()
            split_page.get_by_text("Unstaged Changes (3)", exact=True).locator("xpath=..").locator("button").filter(has_text="src/blob.bin").first.click()
            split_dialog = split_page.locator('[role="dialog"]').last
            expect(split_dialog.get_by_text("Binary", exact=True)).to_be_visible(timeout=10_000)
            assert_dialog_is_mobile_fullscreen(split_page, split_dialog)
            split_dialog.get_by_label("Close").click()
            split_page.get_by_role("button", name="Files", exact=True).click()
            result["splitInspector"] = "ok"

            print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
            mobile_context.close()
            split_context.close()
            browser.close()
        return 0
    finally:
        try:
            close_live_sessions(base_url)
        except Exception:
            pass
        try:
            request_json(base_url, "/api/workspaces/remove", {"dir": workspace})
        except Exception:
            pass
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
