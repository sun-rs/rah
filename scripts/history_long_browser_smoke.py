from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import time
from typing import Any
from urllib import request

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import expect, sync_playwright

ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
PROVIDER_SESSION_ID = "kimi-long-history-session"
WORKSPACE_GROUP_TITLE = "workspace"


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
        return json.load(response)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_ready(base_url: str, timeout_s: int = 30) -> None:
    started = time.time()
    while time.time() - started < timeout_s:
        try:
            with request.urlopen(f"{base_url}/readyz", timeout=2) as response:
                if response.read().decode("utf-8").strip() == "ok":
                    return
        except Exception:
            pass
        time.sleep(0.25)
    raise TimeoutError(f"Timed out waiting for daemon at {base_url}")


def start_temp_daemon(env: dict[str, str], log_path: pathlib.Path) -> subprocess.Popen[bytes]:
    log_file = log_path.open("wb")
    process = subprocess.Popen(
        ["node", "--import", "tsx", "packages/runtime-daemon/src/main.ts"],
        cwd=ROOT_DIR,
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )
    process._rah_log_file = log_file  # type: ignore[attr-defined]
    return process


def stop_temp_daemon(process: subprocess.Popen[bytes] | None) -> None:
    if process is None:
        return
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
    log_file = getattr(process, "_rah_log_file", None)
    if log_file is not None:
        log_file.close()


def project_hash(workspace: pathlib.Path) -> str:
    return hashlib.sha256(str(workspace).encode("utf-8")).hexdigest()


def build_gemini_messages(pair_count: int) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    for index in range(1, pair_count + 1):
        minute = str((index // 60) % 60).zfill(2)
        user_second = str((index * 2) % 60).zfill(2)
        assistant_second = str((index * 2 + 1) % 60).zfill(2)
        messages.append(
            {
                "id": f"msg-user-{index}",
                "timestamp": f"2026-04-22T10:{minute}:{user_second}.000Z",
                "type": "user",
                "content": [{"text": f"LONG-HISTORY-USER-{index:03d}"}],
            }
        )
        messages.append(
            {
                "id": f"msg-gemini-{index}",
                "timestamp": f"2026-04-22T10:{minute}:{assistant_second}.000Z",
                "type": "gemini",
                "content": [{"text": f"LONG-HISTORY-ASSISTANT-{index:03d}"}],
            }
        )
    return messages


def md5(value: str) -> str:
    return hashlib.md5(value.encode("utf-8")).hexdigest()


def write_kimi_metadata(share_dir: pathlib.Path, workspace: pathlib.Path) -> None:
    (share_dir / "kimi.json").write_text(
        json.dumps(
            {
                "work_dirs": [
                    {
                        "path": str(workspace),
                        "kaos": "local",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )


def write_kimi_long_session(share_dir: pathlib.Path, workspace: pathlib.Path, pair_count: int) -> None:
    session_dir = share_dir / "sessions" / md5(str(workspace)) / PROVIDER_SESSION_ID
    session_dir.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps({"type": "metadata", "protocol_version": "1.9"})]
    timestamp = 1_700_000_000
    for index in range(1, pair_count + 1):
        lines.append(
            json.dumps(
                {
                    "timestamp": timestamp,
                    "message": {
                        "type": "TurnBegin",
                        "payload": {
                            "user_input": [{"text": f"LONG-HISTORY-USER-{index:03d}"}],
                        },
                    },
                }
            )
        )
        timestamp += 1
        lines.append(
            json.dumps(
                {
                    "timestamp": timestamp,
                    "message": {
                        "type": "TextPart",
                        "payload": {"text": f"LONG-HISTORY-ASSISTANT-{index:03d}"},
                    },
                }
            )
        )
        timestamp += 1
    (session_dir / "wire.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")


def pick_chat_scroll_metrics(page) -> dict[str, float]:
    metrics = page.evaluate(
        """
        () => {
          const candidates = Array.from(document.querySelectorAll("div.custom-scrollbar"));
          const target = candidates.sort((left, right) => right.scrollHeight - left.scrollHeight)[0];
          if (!target) {
            return null;
          }
          return {
            scrollTop: target.scrollTop,
            clientHeight: target.clientHeight,
            scrollHeight: target.scrollHeight,
          };
        }
        """
    )
    if not isinstance(metrics, dict):
        raise AssertionError("Could not locate chat scroll container.")
    return metrics


def scroll_chat_to_top(page) -> None:
    page.evaluate(
        """
        () => {
          const candidates = Array.from(document.querySelectorAll("div.custom-scrollbar"));
          const target = candidates.sort((left, right) => right.scrollHeight - left.scrollHeight)[0];
          if (target) {
            target.scrollTop = 0;
            target.dispatchEvent(new Event("scroll", { bubbles: true }));
          }
        }
        """
    )


def rendered_feed_row_count(page) -> int:
    count = page.evaluate(
        """
        () => {
          const candidates = Array.from(document.querySelectorAll("div.custom-scrollbar"));
          const target = candidates.sort((left, right) => right.scrollHeight - left.scrollHeight)[0];
          if (!target) {
            return -1;
          }
          const content = target.querySelector("div.mx-auto.w-full.min-w-0.max-w-3xl.space-y-5");
          if (!content) {
            return -1;
          }
          return Array.from(content.children).filter((node) => {
            const text = node.textContent?.trim() ?? "";
            return text.length > 0 && text !== "Loading older history";
          }).length;
        }
        """
    )
    if not isinstance(count, int):
        raise AssertionError("Could not count rendered feed rows.")
    return count


def wait_for_text_absent(page, marker: str) -> None:
    started = time.time()
    while time.time() - started < 10:
        if page.get_by_text(marker).count() == 0:
            return
        page.wait_for_timeout(200)
    raise AssertionError(f"Expected {marker} to stay absent from the initial tail window.")


def load_older_history_until_scroll_grows(page, baseline_scroll_height: float, attempts: int = 6) -> dict[str, float]:
    for _ in range(attempts):
        scroll_chat_to_top(page)
        page.wait_for_timeout(1200)
        metrics = pick_chat_scroll_metrics(page)
        if metrics["scrollHeight"] > baseline_scroll_height + 400:
            return metrics
    raise AssertionError(
        f"Scrolling older history never increased scroll height beyond baseline {baseline_scroll_height}."
    )


def open_history_session(page) -> None:
    page.locator('button[aria-label="Session history"]:visible').first.click()
    page.get_by_role("button", name="All").click()
    page.get_by_placeholder("Filter workspaces or sessions…").fill(PROVIDER_SESSION_ID)
    row = page.locator(f'[data-provider-session-id="{PROVIDER_SESSION_ID}"]').first
    expect(row).to_be_visible(timeout=30_000)
    row.click()
    expect(page.get_by_text("History only").first).to_be_visible(timeout=30_000)


def close_history_session(page) -> None:
    page.get_by_role("button", name="Close").click()
    expect(page.get_by_text("History only")).to_have_count(0, timeout=30_000)


def main() -> int:
    temp_root = pathlib.Path(tempfile.mkdtemp(prefix="rah-history-long-browser-"))
    daemon: subprocess.Popen[bytes] | None = None

    try:
        rah_home = temp_root / "rah-home"
        kimi_share = temp_root / "kimi-share"
        workspace = temp_root / "workspace"
        log_path = temp_root / "daemon.log"

        workspace.mkdir(parents=True, exist_ok=True)
        kimi_share.mkdir(parents=True, exist_ok=True)
        write_kimi_metadata(kimi_share, workspace)
        write_kimi_long_session(kimi_share, workspace, 900)

        port = free_port()
        base_url = f"http://127.0.0.1:{port}"
        env = dict(os.environ)
        env["RAH_HOME"] = str(rah_home)
        env["KIMI_SHARE_DIR"] = str(kimi_share)
        env["RAH_PORT"] = str(port)
        daemon = start_temp_daemon(env, log_path)
        wait_for_ready(base_url)

        request_json(base_url, "/api/workspaces/add", {"dir": str(workspace)})
        request_json(base_url, "/api/workspaces/select", {"dir": str(workspace)})
        sessions = request_json(base_url, "/api/sessions")
        if not any(
            isinstance(item, dict) and item.get("provider") == "kimi" and item.get("providerSessionId") == PROVIDER_SESSION_ID
            for item in sessions.get("storedSessions", [])
        ):
            raise AssertionError("Temporary Kimi long-history session was not discovered by the daemon.")

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1440, "height": 960})
            page.set_default_timeout(30_000)
            page.goto(base_url, wait_until="domcontentloaded")
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(1500)

            open_history_session(page)

            expect(page.get_by_text("LONG-HISTORY-ASSISTANT-900")).to_be_visible(timeout=30_000)
            wait_for_text_absent(page, "LONG-HISTORY-ASSISTANT-500")

            metrics = pick_chat_scroll_metrics(page)
            if metrics["scrollHeight"] - metrics["clientHeight"] - metrics["scrollTop"] > 72:
                raise AssertionError(f"Long history did not open anchored to bottom: {metrics}")

            older_metrics = load_older_history_until_scroll_grows(page, metrics["scrollHeight"])

            rendered_rows = rendered_feed_row_count(page)
            if rendered_rows <= 0 or rendered_rows >= 220:
                raise AssertionError(f"Expected virtualized long history row count to stay bounded, got {rendered_rows}.")

            close_history_session(page)
            write_kimi_long_session(kimi_share, workspace, 910)
            page.wait_for_timeout(1200)

            open_history_session(page)
            expect(page.get_by_text("LONG-HISTORY-ASSISTANT-910")).to_be_visible(timeout=30_000)
            wait_for_text_absent(page, "LONG-HISTORY-ASSISTANT-500")

            result = {
                "initialBottomMetrics": metrics,
                "olderMetrics": older_metrics,
                "renderedRowsAfterOlderPaging": rendered_rows,
                "reopenedLatestMarker": "LONG-HISTORY-ASSISTANT-910",
            }
            print(json.dumps(result, indent=2))
            browser.close()
        return 0
    except PlaywrightTimeoutError as exc:
        print(f"History long browser smoke timed out: {exc}")
        return 1
    finally:
        stop_temp_daemon(daemon)
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
