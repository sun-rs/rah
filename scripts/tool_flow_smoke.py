from __future__ import annotations

import json
import os
import pathlib
import shutil
import tempfile
import time
from typing import Any
from urllib import request

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import expect, sync_playwright


def count_text(haystack: str, needle: str) -> int:
    count = 0
    start = 0
    while True:
        idx = haystack.find(needle, start)
        if idx == -1:
            return count
        count += 1
        start = idx + len(needle)


def request_json(base_url: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    if payload is None:
        req = request.Request(f"{base_url}{path}")
    else:
        req = request.Request(
            f"{base_url}{path}",
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
        )
    with request.urlopen(req, timeout=30) as response:
        return json.load(response)


def cleanup_live_sessions(base_url: str) -> None:
    sessions = request_json(base_url, "/api/sessions").get("sessions", [])
    for session in sessions:
        session_id = session["session"]["id"]
        attached = session.get("attachedClients", [])
        attached_client_id = None
        if isinstance(attached, list):
            for client in attached:
                if isinstance(client, dict) and isinstance(client.get("id"), str):
                    attached_client_id = client["id"]
                    break
        client_id = (
            session.get("controlLease", {}).get("holderClientId")
            or attached_client_id
            or "web-tool-smoke"
        )
        try:
            request_json(base_url, f"/api/sessions/{session_id}/close", {"clientId": client_id})
        except Exception:
            continue


def gather_matching_user_events(socket_messages: list[Any], token: str) -> tuple[int, str | None]:
    count = 0
    turn_id = None
    for batch in socket_messages:
        events = batch.get("events") if isinstance(batch, dict) else None
        if not isinstance(events, list):
            continue
        for event in events:
            if not isinstance(event, dict) or event.get("type") != "timeline.item.added":
                continue
            payload = event.get("payload")
            if not isinstance(payload, dict):
                continue
            item = payload.get("item")
            if not isinstance(item, dict) or item.get("kind") != "user_message":
                continue
            text = item.get("text")
            if isinstance(text, str) and token in text:
                count += 1
                if isinstance(event.get("turnId"), str):
                    turn_id = event["turnId"]
    return count, turn_id


def gather_tool_ids_for_turn(socket_messages: list[Any], turn_id: str | None) -> list[str]:
    if turn_id is None:
        return []
    tool_ids: list[str] = []
    for batch in socket_messages:
        events = batch.get("events") if isinstance(batch, dict) else None
        if not isinstance(events, list):
            continue
        for event in events:
            if not isinstance(event, dict) or event.get("turnId") != turn_id:
                continue
            if event.get("type") != "tool.call.started":
                continue
            payload = event.get("payload")
            if not isinstance(payload, dict):
                continue
            tool_call = payload.get("toolCall")
            if not isinstance(tool_call, dict):
                continue
            tool_id = tool_call.get("id")
            if isinstance(tool_id, str):
                tool_ids.append(tool_id)
    return sorted(set(tool_ids))


def assert_no_environment_leak(body: str) -> None:
    if "<environment_context>" in body:
        raise AssertionError("Environment context leaked into the chat UI.")


def count_user_bubbles(page, token: str) -> int:
    return page.locator('div.flex.items-start.justify-end', has_text=token).count()


def wait_for_turn_activity(
    page,
    token: str,
    *,
    require_tools: bool,
    timeout_ms: int = 180_000,
) -> tuple[int, str | None, list[str]]:
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        socket_messages = page.evaluate("window.__rahSocketMessages")
        user_count, turn_id = gather_matching_user_events(socket_messages, token)
        tool_ids = gather_tool_ids_for_turn(socket_messages, turn_id)
        if user_count >= 1 and (not require_tools or len(tool_ids) >= 1):
            return user_count, turn_id, tool_ids
        page.wait_for_timeout(1000)
    raise AssertionError(f"Timed out waiting for turn activity for {token}.")


def main() -> int:
    base_url = os.environ.get("RAH_BASE_URL", "http://127.0.0.1:43111")
    cleanup_live_sessions(base_url)
    workspace = pathlib.Path(tempfile.mkdtemp(prefix="rah-tool-flow-"))
    readme = workspace / "README.md"
    readme.write_text("RAH TOOL FLOW\n", encoding="utf-8")
    request_json(base_url, "/api/workspaces/add", {"dir": str(workspace)})
    request_json(base_url, "/api/workspaces/select", {"dir": str(workspace)})

    now = int(time.time())
    new_token = f"RAH-NEW-TOOL-{now}"
    history_token = f"RAH-HISTORY-TOOL-{now}"
    instruction_template = (
        "请先读取当前工作目录下 README.md 的第一行，再执行 pwd。完成后用一句简短中文总结，不要重复这个标记：{token}"
    )
    new_prompt = instruction_template.format(token=new_token)
    history_prompt = instruction_template.format(token=history_token)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1400, "height": 960})
        page.add_init_script(
            """
            (() => {
              try {
                window.localStorage.removeItem('rah.lastHistorySelection');
                window.sessionStorage.removeItem('rah.lastHistorySelection');
              } catch {}
              const NativeWS = window.WebSocket;
              window.__rahSocketMessages = [];
              window.WebSocket = function(url, protocols) {
                const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
                ws.addEventListener('message', (event) => {
                  try {
                    window.__rahSocketMessages.push(JSON.parse(event.data));
                  } catch {}
                });
                return ws;
              };
              window.WebSocket.prototype = NativeWS.prototype;
            })();
            """
        )
        page.set_default_timeout(30_000)

        try:
            page.goto(base_url, wait_until="domcontentloaded")
            page.evaluate(
                "() => { window.localStorage.removeItem('rah.lastHistorySelection'); window.sessionStorage.removeItem('rah.lastHistorySelection'); }"
            )
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(1500)
            if page.get_by_text("Open history only").count() > 0:
                page.get_by_role("button", name="Close").click()
                page.wait_for_timeout(1500)

            page.get_by_role("button", name="New session").click()
            expect(page.get_by_role("heading", name="New session")).to_be_visible()
            page.get_by_role("button", name="Create session").click()
            expect(page.get_by_placeholder("Message…")).to_be_visible(timeout=90_000)

            page.get_by_placeholder("Message…").fill(new_prompt)
            page.keyboard.press("Enter")
            new_user_count, new_turn_id, new_tool_ids = wait_for_turn_activity(
                page,
                new_token,
                require_tools=True,
            )

            body_after_new = page.locator("body").inner_text()
            sessions_during_live = request_json(base_url, "/api/sessions").get("sessions", [])
            latest_provider_session_id = None
            if isinstance(sessions_during_live, list):
                for session in sessions_during_live:
                    if not isinstance(session, dict):
                        continue
                    summary = session.get("session")
                    if not isinstance(summary, dict):
                        continue
                    provider_session_id = summary.get("providerSessionId")
                    if isinstance(provider_session_id, str):
                        latest_provider_session_id = provider_session_id
                        break
            if not latest_provider_session_id:
                raise AssertionError("Could not determine providerSessionId for the new live session.")

            page.get_by_role("button", name="Close").click()
            page.wait_for_timeout(1500)

            page.locator('button[aria-label="Session history"]:visible').first.click()
            page.get_by_role("button", name="Recent", exact=True).click()
            page.get_by_placeholder("Filter recent sessions…").fill(latest_provider_session_id)
            page.locator(
                f'[role="dialog"] button[data-provider-session-id="{latest_provider_session_id}"]:visible'
            ).first.click()
            expect(page.get_by_text("Open history only")).to_be_visible()
            expect(page.get_by_text(new_token).first).to_be_visible(timeout=60_000)

            body_before_claim = page.locator("body").inner_text()
            history_before_count = count_text(body_before_claim, new_token)

            page.get_by_role("button", name="Claim control").click()
            expect(page.get_by_placeholder("Message…")).to_be_visible(timeout=90_000)
            page.wait_for_timeout(2500)

            body_after_claim = page.locator("body").inner_text()
            history_after_claim_count = count_text(body_after_claim, new_token)

            page.get_by_placeholder("Message…").fill(history_prompt)
            page.keyboard.press("Enter")
            history_user_count, history_turn_id, history_tool_ids = wait_for_turn_activity(
                page,
                history_token,
                require_tools=True,
            )

            final_body = page.locator("body").inner_text()

            result = {
                "baseUrl": base_url,
                "newFlow": {
                    "token": new_token,
                    "userBubbleCount": count_user_bubbles(page, new_token),
                    "matchingUserEventCount": new_user_count,
                    "toolCallIds": new_tool_ids,
                },
                "historyClaimFlow": {
                    "token": history_token,
                    "userBubbleCount": count_user_bubbles(page, history_token),
                    "matchingUserEventCount": history_user_count,
                    "toolCallIds": history_tool_ids,
                    "oldTurnCountBeforeClaim": history_before_count,
                    "oldTurnCountAfterClaim": history_after_claim_count,
                },
                "bodySnippet": final_body[-4000:],
            }
            print(json.dumps(result, ensure_ascii=False, indent=2))

            assert_no_environment_leak(final_body)

            if result["newFlow"]["matchingUserEventCount"] != 1:
                raise AssertionError("New session flow emitted duplicate live user_message events.")
            if result["newFlow"]["userBubbleCount"] != 1:
                raise AssertionError("New session flow rendered duplicate user prompt bubbles.")
            if len(new_tool_ids) < 1:
                raise AssertionError("New session flow did not surface any tool calls.")
            if result["historyClaimFlow"]["oldTurnCountAfterClaim"] != result["historyClaimFlow"]["oldTurnCountBeforeClaim"]:
                raise AssertionError("History claim replayed older visible history.")
            if result["historyClaimFlow"]["matchingUserEventCount"] != 1:
                raise AssertionError("History claim flow emitted duplicate live user_message events.")
            if result["historyClaimFlow"]["userBubbleCount"] != 1:
                raise AssertionError("History claim flow rendered duplicate user prompt bubbles.")
            if len(history_tool_ids) < 1:
                raise AssertionError("History claim flow did not surface any tool calls.")

            return 0
        except (AssertionError, PlaywrightTimeoutError) as exc:
            try:
                body = page.locator("body").inner_text()
                socket_messages = page.evaluate("window.__rahSocketMessages")
                print(
                    json.dumps(
                        {
                            "error": str(exc),
                            "bodySnippet": body[-4000:],
                            "socketTail": socket_messages[-20:],
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                    file=os.sys.stderr,
                )
            except Exception:
                pass
            print(str(exc), file=os.sys.stderr)
            return 1
        finally:
            browser.close()
            shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
