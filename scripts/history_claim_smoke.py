from __future__ import annotations

import json
import os
import sys
import time
from typing import Any
from urllib import error, request

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
            or "web-claim-smoke"
        )
        try:
            request_json(
                base_url,
                f"/api/sessions/{session_id}/close",
                {"clientId": client_id},
            )
        except error.HTTPError:
            continue


def main() -> int:
    base_url = os.environ.get("RAH_BASE_URL", "http://127.0.0.1:43111")
    cleanup_live_sessions(base_url)
    sessions_response = request_json(base_url, "/api/sessions")
    recent_sessions = sessions_response.get("recentSessions", [])
    stored_sessions = sessions_response.get("storedSessions", [])
    recent_codex_provider_session_id = next(
        (
            item.get("providerSessionId")
            for item in recent_sessions
            if isinstance(item, dict)
            and item.get("provider") == "codex"
            and isinstance(item.get("providerSessionId"), str)
        ),
        None,
    )
    stored_codex_provider_session_id = next(
        (
            item.get("providerSessionId")
            for item in stored_sessions
            if isinstance(item, dict)
            and item.get("provider") == "codex"
            and isinstance(item.get("providerSessionId"), str)
        ),
        None,
    )
    codex_provider_session_id = recent_codex_provider_session_id or stored_codex_provider_session_id
    if not isinstance(codex_provider_session_id, str) or not codex_provider_session_id:
        print("No recent Codex history session available for history-claim smoke.", file=sys.stderr)
        return 1
    codex_history_ref = next(
        (
            item
            for item in recent_sessions + stored_sessions
            if isinstance(item, dict)
            and item.get("provider") == "codex"
            and item.get("providerSessionId") == codex_provider_session_id
        ),
        None,
    )
    expected_history_snippet = None
    if isinstance(codex_history_ref, dict):
        preview = codex_history_ref.get("preview")
        title = codex_history_ref.get("title")
        expected_history_snippet = next(
            (
                value[:8]
                for value in (preview, title)
                if isinstance(value, str) and value.strip()
            ),
            None,
        )

    prompt = f"RAH-CLAIM-SMOKE-{int(time.time())}"

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 430, "height": 932})
        page.add_init_script(
            """
            (() => {
              try {
                window.localStorage.removeItem('rah.lastHistorySelection');
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
            page.locator('button[aria-label="Session history"]:visible').first.click()
            if recent_codex_provider_session_id:
                page.get_by_role("button", name="Recent").click()
                page.locator(
                    f'[role="dialog"] button[data-provider-session-id="{codex_provider_session_id}"]:visible'
                ).first.click()
            else:
                page.get_by_role("button", name="All").click()
                page.get_by_placeholder("Filter workspaces or sessions…").fill(codex_provider_session_id)
                page.locator(
                    f'[role="dialog"] button[data-provider-session-id="{codex_provider_session_id}"]:visible'
                ).first.click()
            expect(page.get_by_text("Open history only")).to_be_visible()
            if expected_history_snippet:
                expect(page.get_by_text(expected_history_snippet).first).to_be_visible(timeout=30_000)

            page.get_by_role("button", name="Claim control").click()
            expect(page.get_by_placeholder("Message…")).to_be_visible(timeout=90_000)

            page.get_by_placeholder("Message…").fill(prompt)
            page.keyboard.press("Enter")
            page.wait_for_timeout(10_000)

            body = page.locator("body").inner_text()
            socket_messages = page.evaluate("window.__rahSocketMessages")

            matching_user_events: list[dict[str, Any]] = []
            matching_assistant_events: list[dict[str, Any]] = []
            for batch in socket_messages:
                events = batch.get("events") if isinstance(batch, dict) else None
                if not isinstance(events, list):
                    continue
                for event in events:
                    if not isinstance(event, dict):
                        continue
                    if event.get("type") != "timeline.item.added":
                        continue
                    payload = event.get("payload")
                    if not isinstance(payload, dict):
                        continue
                    item = payload.get("item")
                    if not isinstance(item, dict):
                        continue
                    if item.get("kind") != "user_message":
                        continue
                    if item.get("text") != prompt:
                        continue
                    matching_user_events.append(event)
            matching_turn_ids = {
                event.get("turnId")
                for event in matching_user_events
                if isinstance(event.get("turnId"), str)
            }
            for batch in socket_messages:
                events = batch.get("events") if isinstance(batch, dict) else None
                if not isinstance(events, list):
                    continue
                for event in events:
                    if not isinstance(event, dict):
                        continue
                    if event.get("type") != "timeline.item.added":
                        continue
                    if event.get("turnId") not in matching_turn_ids:
                        continue
                    payload = event.get("payload")
                    if not isinstance(payload, dict):
                        continue
                    item = payload.get("item")
                    if not isinstance(item, dict):
                        continue
                    if item.get("kind") != "assistant_message":
                        continue
                    matching_assistant_events.append(event)

            result = {
                "baseUrl": base_url,
                "prompt": prompt,
                "bodyCount": count_text(body, prompt),
                "matchingUserEventCount": len(matching_user_events),
                "matchingAssistantEventCount": len(matching_assistant_events),
                "environmentLeak": "<environment_context>" in body,
                "bodySnippet": body[-3000:],
            }
            print(json.dumps(result, ensure_ascii=False, indent=2))

            if result["matchingUserEventCount"] != 1:
                print("Expected exactly one live user_message event for the smoke prompt.", file=sys.stderr)
                return 1
            if result["bodyCount"] != 1:
                print("Expected exactly one visible user prompt occurrence in the UI.", file=sys.stderr)
                return 1
            if result["matchingAssistantEventCount"] < 1:
                print("Expected at least one assistant response event for the claimed live turn.", file=sys.stderr)
                return 1
            if result["environmentLeak"]:
                print("Environment context leaked into the chat UI.", file=sys.stderr)
                return 1
            return 0
        except PlaywrightTimeoutError as exc:
            print(f"Smoke test timed out: {exc}", file=sys.stderr)
            return 1
        finally:
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
