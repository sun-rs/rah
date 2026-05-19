from __future__ import annotations

import json
import os
import pathlib
import re
import tempfile
import time
from typing import Any
from urllib import request

from playwright.sync_api import expect, sync_playwright

from rah_smoke_cleanup import cleanup_smoke_workspace

REAL_BROWSER_CASE_IDS = [
    "REAL-PROVIDER-001",
    "REAL-CLAUDE-TMUX-MIRROR-001",
    "REAL-CLAUDE-PASSTHROUGH-001",
    "REAL-CLAUDE-ESC-BEST-EFFORT-001",
    "REAL-CLAUDE-NO-SYNTHETIC-INTERRUPT-001",
    "REAL-CLAUDE-HISTORY-REPLAY-001",
    "REAL-CLAUDE-HISTORY-CLAIM-001",
    "REAL-CLAUDE-SECOND-TURN-001",
]


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
        return json.load(response)


def close_live_sessions(base_url: str) -> None:
    sessions = request_json(base_url, "/api/sessions").get("sessions", [])
    for session in sessions:
        summary = session.get("session") if isinstance(session, dict) else None
        if not isinstance(summary, dict) or summary.get("provider") != "claude":
            continue
        session_id = summary.get("id")
        if not isinstance(session_id, str):
            continue
        attached_clients = session.get("attachedClients") if isinstance(session, dict) else None
        client_id = session.get("controlLease", {}).get("holderClientId") if isinstance(session, dict) else None
        if not isinstance(client_id, str) and isinstance(attached_clients, list):
            for attached in attached_clients:
                if isinstance(attached, dict) and isinstance(attached.get("id"), str):
                    client_id = attached["id"]
                    break
        if not isinstance(client_id, str):
            client_id = "claude-browser-smoke"
        try:
            request_json(base_url, f"/api/sessions/{session_id}/close", {"clientId": client_id})
        except Exception:
            continue


def close_session(base_url: str, session_id: str, client_id: str | None = None) -> None:
    try:
        if client_id is None:
            summary = request_json(base_url, f"/api/sessions/{session_id}")["session"]
            client_id = summary.get("controlLease", {}).get("holderClientId")
            if not isinstance(client_id, str):
                attached = summary.get("attachedClients", [])
                if isinstance(attached, list):
                    for client in attached:
                        if isinstance(client, dict) and isinstance(client.get("id"), str):
                            client_id = client["id"]
                            break
        if not isinstance(client_id, str):
            client_id = "claude-browser-smoke"
        request_json(base_url, f"/api/sessions/{session_id}/close", {"clientId": client_id})
    except Exception:
        pass


def resolve_control_client_id(base_url: str, session_id: str, fallback: str) -> str:
    try:
        summary = request_json(base_url, f"/api/sessions/{session_id}")["session"]
        client_id = summary.get("controlLease", {}).get("holderClientId")
        if isinstance(client_id, str):
            return client_id
        attached = summary.get("attachedClients", [])
        if isinstance(attached, list):
            for client in attached:
                if isinstance(client, dict) and isinstance(client.get("id"), str):
                    return client["id"]
    except Exception:
        pass
    return fallback


def wait_for_session_match(base_url: str, predicate, *, timeout_s: int = 90) -> dict[str, Any]:
    started = time.time()
    while time.time() - started < timeout_s:
        sessions = request_json(base_url, "/api/sessions").get("sessions", [])
        for session in sessions:
            if predicate(session):
                return session
        time.sleep(1)
    raise TimeoutError("Timed out waiting for session match.")


def count_text(haystack: str, needle: str) -> int:
    count = 0
    start = 0
    while True:
        idx = haystack.find(needle, start)
        if idx == -1:
            return count
        count += 1
        start = idx + len(needle)


def wait_for_body_text_count(page, text: str, minimum: int, *, timeout_s: int = 120) -> str:
    started = time.time()
    last = ""
    while time.time() - started < timeout_s:
        last = page.locator("body").inner_text()
        if count_text(last, text) >= minimum:
            return last
        page.wait_for_timeout(1000)
    raise TimeoutError(
        f"Timed out waiting for body to contain {text!r} at least {minimum} times. "
        f"Last count={count_text(last, text)} snippet: {last[-1200:]}"
    )


def chat_text(page) -> str:
    return page.get_by_test_id("chat-thread-scroll-container").inner_text()


def wait_for_chat_contains(page, text: str, *, timeout_s: int = 90) -> str:
    started = time.time()
    last = ""
    while time.time() - started < timeout_s:
        last = chat_text(page)
        if text in last:
            return last
        page.wait_for_timeout(1000)
    raise TimeoutError(f"Timed out waiting for chat to contain {text!r}. Last chat snippet: {last[-1200:]}")


def wait_for_chat_text_count(page, text: str, minimum: int, *, timeout_s: int = 120) -> str:
    started = time.time()
    last = ""
    while time.time() - started < timeout_s:
        last = chat_text(page)
        if count_text(last, text) >= minimum:
            return last
        page.wait_for_timeout(1000)
    raise TimeoutError(
        f"Timed out waiting for chat to contain {text!r} at least {minimum} times. "
        f"Last count={count_text(last, text)} snippet: {last[-1200:]}"
    )


def stop_button(page):
    return page.get_by_role("button", name="Stop generating")


def claude_esc_button(page):
    return page.get_by_role("button", name=re.compile(r"(Esc|Send Esc)")).last


def send_button(page):
    return page.get_by_role("button", name="Send message").last


def visible_composer(page):
    return page.locator("textarea:visible").last


def assert_stop_absent(page, *, timeout_s: int = 45) -> None:
    expect(stop_button(page)).to_have_count(0, timeout=timeout_s * 1000)


def assert_claude_esc_available(page, *, timeout_s: int = 45) -> None:
    expect(claude_esc_button(page)).to_be_visible(timeout=timeout_s * 1000)
    expect(claude_esc_button(page)).to_be_enabled(timeout=timeout_s * 1000)


def assert_composer_ready(page, *, timeout_s: int = 45) -> None:
    composer = visible_composer(page)
    expect(composer).to_be_visible(timeout=timeout_s * 1000)
    expect(composer).to_be_enabled(timeout=timeout_s * 1000)


def send_chat_message(page, text: str) -> None:
    composer = visible_composer(page)
    expect(composer).to_be_visible(timeout=90_000)
    expect(composer).to_be_enabled(timeout=45_000)
    composer.fill(text)
    expect(send_button(page)).to_be_enabled(timeout=45_000)
    page.keyboard.press("Enter")


def assert_no_chat_noise(body: str) -> None:
    for needle in ("Loading older history", "Unhandled provider event", "Action failed"):
        if needle in body:
            raise AssertionError(f"Unexpected chat noise: {needle}")


def assert_text_order(body: str, *needles: str) -> None:
    cursor = -1
    for needle in needles:
        index = body.find(needle, cursor + 1)
        if index < 0:
            raise AssertionError(f"Expected {needle!r} after offset {cursor}; body tail: {body[-1600:]}")
        cursor = index


def assert_interrupt_notice_count(body: str, expected: int) -> None:
    count = count_text(body, "Conversation interrupted")
    if count != expected:
        raise AssertionError(
            f"Expected exactly {expected} interrupt notice(s), saw {count}. Body tail: {body[-1600:]}"
        )


def wait_for_provider_session_id(base_url: str, session_id: str, *, timeout_s: int = 120) -> str:
    started = time.time()
    last: dict[str, Any] | None = None
    while time.time() - started < timeout_s:
        last = request_json(base_url, f"/api/sessions/{session_id}")["session"]
        provider_session_id = last["session"].get("providerSessionId")
        if isinstance(provider_session_id, str) and provider_session_id:
            return provider_session_id
        time.sleep(1)
    raise TimeoutError(f"Timed out waiting for Claude providerSessionId; last={last}")


def wait_for_history_text_count(base_url: str, session_id: str, text: str, minimum: int, *, timeout_s: int = 180) -> str:
    started = time.time()
    last = ""
    while time.time() - started < timeout_s:
        history = request_json(base_url, f"/api/sessions/{session_id}/history?limit=200")
        last = json.dumps(history, ensure_ascii=False)
        if count_text(last, text) >= minimum:
            return last
        time.sleep(1)
    raise TimeoutError(
        f"Timed out waiting for history to contain {text!r} at least {minimum} times. "
        f"Last count={count_text(last, text)} snippet: {last[-1600:]}"
    )


def approve_pending_permissions(page, base_url: str, session_id: str, handled: set[str]) -> list[str]:
    seen: list[str] = []
    socket_messages = page.evaluate("window.__rahSocketMessages")
    for batch in socket_messages:
        events = batch.get("events") if isinstance(batch, dict) else None
        if not isinstance(events, list):
            continue
        for event in events:
            if not isinstance(event, dict) or event.get("sessionId") != session_id:
                continue
            if event.get("type") != "permission.requested":
                continue
            payload = event.get("payload")
            if not isinstance(payload, dict):
                continue
            request_payload = payload.get("request")
            if not isinstance(request_payload, dict):
                continue
            request_id = request_payload.get("id")
            if not isinstance(request_id, str) or request_id in handled:
                continue
            request_json(
                base_url,
                f"/api/sessions/{session_id}/permissions/{request_id}/respond",
                {
                    "behavior": "allow",
                    "selectedActionId": "allow_for_session",
                    "decision": "approved_for_session",
                },
            )
            handled.add(request_id)
            seen.append(request_id)
    return seen


def wait_for_chat_text_count_with_permissions(
    page,
    base_url: str,
    session_id: str,
    text: str,
    minimum: int,
    *,
    timeout_s: int = 240,
) -> tuple[str, list[str]]:
    started = time.time()
    last = ""
    handled: set[str] = set()
    seen_permissions: list[str] = []
    while time.time() - started < timeout_s:
        seen_permissions.extend(approve_pending_permissions(page, base_url, session_id, handled))
        last = chat_text(page)
        if count_text(last, text) >= minimum:
            return last, seen_permissions
        page.wait_for_timeout(1000)
    raise TimeoutError(
        f"Timed out waiting for chat to contain {text!r} at least {minimum} times. "
        f"Last count={count_text(last, text)} snippet: {last[-1600:]}"
    )


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


def wait_for_idle_with_auto_permissions(
    page,
    base_url: str,
    session_id: str,
    *,
    timeout_s: int = 240,
) -> tuple[dict[str, Any], list[str]]:
    started = time.time()
    seen_request_ids: list[str] = []
    handled = set()
    last: dict[str, Any] | None = None

    while time.time() - started < timeout_s:
        socket_messages = page.evaluate("window.__rahSocketMessages")
        for batch in socket_messages:
            events = batch.get("events") if isinstance(batch, dict) else None
            if not isinstance(events, list):
                continue
            for event in events:
                if not isinstance(event, dict) or event.get("sessionId") != session_id:
                    continue
                if event.get("type") != "permission.requested":
                    continue
                payload = event.get("payload")
                if not isinstance(payload, dict):
                    continue
                request_payload = payload.get("request")
                if not isinstance(request_payload, dict):
                    continue
                request_id = request_payload.get("id")
                if not isinstance(request_id, str) or request_id in handled:
                    continue
                request_json(
                    base_url,
                    f"/api/sessions/{session_id}/permissions/{request_id}/respond",
                    {
                        "behavior": "allow",
                        "selectedActionId": "allow_for_session",
                        "decision": "approved_for_session",
                    },
                )
                handled.add(request_id)
                seen_request_ids.append(request_id)

        last = request_json(base_url, f"/api/sessions/{session_id}")["session"]
        if last["session"]["runtimeState"] in ("idle", "failed", "stopped"):
            return last, seen_request_ids
        time.sleep(1)

    raise TimeoutError(f"Timed out waiting for {session_id}; last={last}")


def main() -> int:
    base_url = os.environ.get("RAH_BASE_URL", "http://127.0.0.1:43111")
    close_live_sessions(base_url)

    workspace = pathlib.Path(tempfile.mkdtemp(prefix="rah-claude-browser-"))
    token = str(int(time.time()))
    first_marker = f"CLAUDE-BROWSER-1-{token}"
    second_marker = f"CLAUDE-BROWSER-2-{token}"
    interrupt_marker = f"CLAUDE-BROWSER-INTERRUPT-{token}"
    recovery_marker = f"CLAUDE-BROWSER-RECOVERY-{token}"
    interrupt2_marker = f"CLAUDE-BROWSER-INTERRUPT2-{token}"
    recovery2_marker = f"CLAUDE-BROWSER-RECOVERY2-{token}"
    first_prompt = (
        "Do not use tools. "
        f"Reply with exactly this marker and no extra text: {first_marker}"
    )
    second_prompt = (
        "Do not use tools. "
        f"Reply with exactly this marker and no extra text: {second_marker}"
    )
    interrupt_prompt = (
        "Use the Bash tool to run a command that sleeps for 20 seconds. "
        f"Only after the sleep finishes, reply exactly {interrupt_marker}. "
        "This turn is part of a real browser interruption test."
    )
    recovery_prompt = (
        "Do not use tools. "
        f"Reply immediately with exactly this marker and no extra text: {recovery_marker}"
    )
    interrupt2_prompt = (
        "Use the Bash tool to run a command that sleeps for 20 seconds. "
        f"Only after the sleep finishes, reply exactly {interrupt2_marker}. "
        "This turn is part of a real browser second interruption test."
    )
    recovery2_prompt = (
        "Do not use tools. "
        f"Reply immediately with exactly this marker and no extra text: {recovery2_marker}"
    )

    request_json(base_url, "/api/workspaces/add", {"dir": str(workspace)})
    request_json(base_url, "/api/workspaces/select", {"dir": str(workspace)})

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 960})
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

        live_session_id: str | None = None
        replay_session_id: str | None = None
        resumed_session_id: str | None = None
        client_id = f"claude-browser-seed-{token}"

        try:
            page.goto(base_url, wait_until="domcontentloaded")
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(1500)

            seeded = request_json(
                base_url,
                "/api/sessions/start",
                {
                    "provider": "claude",
                    "cwd": str(workspace),
                    "liveBackend": "tui_mux",
                    "approvalPolicy": "never",
                    "attach": {
                        "client": {
                            "id": client_id,
                            "kind": "web",
                            "connectionId": client_id,
                        },
                        "mode": "interactive",
                        "claimControl": True,
                    },
                },
            )["session"]
            live_session_id = seeded["session"]["id"]
            input_client_id = resolve_control_client_id(base_url, live_session_id, client_id)
            request_json(
                base_url,
                f"/api/sessions/{live_session_id}/input",
                {"clientId": input_client_id, "text": first_prompt},
            )
            provider_session_id = wait_for_provider_session_id(base_url, live_session_id)
            wait_for_history_text_count(base_url, live_session_id, first_marker, 2, timeout_s=240)
            # Claude TUI mux is a history mirror, not an authoritative idle
            # source. Give the native TUI a short settle window before closing
            # the seed session so the smoke does not manufacture a provider
            # "Conversation interrupted" history row while testing replay.
            time.sleep(4)
            close_session(base_url, live_session_id, input_client_id)
            live_session_id = None
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(1500)

            sessions_after_close = request_json(base_url, "/api/sessions")
            recent = [
                item
                for item in sessions_after_close["recentSessions"]
                if item["provider"] == "claude" and item["providerSessionId"] == provider_session_id
            ]
            stored = [
                item
                for item in sessions_after_close["storedSessions"]
                if item["provider"] == "claude" and item["providerSessionId"] == provider_session_id
            ]
            if not recent or not stored:
                raise AssertionError("Claude session did not appear in Recent/Stored after close.")

            page.locator('button[aria-label="Sessions"]:visible').first.click()
            page.get_by_role("button", name="Recent", exact=True).click()
            page.locator(
                f'button[data-provider-session-id="{provider_session_id}"]:visible'
            ).first.click()

            replay = wait_for_session_match(
                base_url,
                lambda item: item["session"]["provider"] == "claude"
                and item["session"].get("providerSessionId") == provider_session_id
                and item["session"]["capabilities"]["steerInput"] is False,
                timeout_s=90,
            )
            replay_session_id = replay["session"]["id"]
            expect(page.get_by_text("History only", exact=True)).to_be_visible(timeout=60_000)
            body_after_replay = wait_for_chat_contains(page, first_marker, timeout_s=90)
            if count_text(body_after_replay, first_marker) < 1:
                raise AssertionError("Claude history replay did not show the first turn marker in the UI.")

            page.get_by_role("button", name="Claim control").click()
            composer = page.locator("textarea:visible").last
            expect(composer).to_be_visible(timeout=90_000)

            resumed = wait_for_session_match(
                base_url,
                lambda item: item["session"]["provider"] == "claude"
                and item["session"].get("providerSessionId") == provider_session_id
                and item["session"]["capabilities"]["steerInput"] is True,
                timeout_s=90,
            )
            resumed_session_id = resumed["session"]["id"]

            old_turn_count_before = count_text(chat_text(page), first_marker)

            composer.fill(second_prompt)
            page.keyboard.press("Enter")

            body_after_second, second_permission_ids = wait_for_chat_text_count_with_permissions(
                page,
                base_url,
                resumed_session_id,
                second_marker,
                2,
                timeout_s=240,
            )
            assert_stop_absent(page)
            assert_claude_esc_available(page)
            assert_composer_ready(page)
            if count_text(body_after_second, second_marker) != 2:
                raise AssertionError("Expected Claude browser second turn marker in both user and assistant output.")

            send_chat_message(page, interrupt_prompt)
            assert_stop_absent(page)
            assert_claude_esc_available(page)
            claude_esc_button(page).click(timeout=60_000)
            try:
                claude_esc_button(page).click(timeout=1000)
            except Exception:
                pass
            page.wait_for_timeout(1500)
            interrupt_state = request_json(base_url, f"/api/sessions/{resumed_session_id}")["session"]
            if interrupt_state["session"]["runtimeState"] in ("failed", "stopped"):
                raise AssertionError(f"Claude Esc flow ended in {interrupt_state['session']['runtimeState']}.")
            assert_stop_absent(page)
            assert_claude_esc_available(page)
            assert_composer_ready(page)
            body_after_interrupt = chat_text(page)
            assert_interrupt_notice_count(body_after_interrupt, 0)
            if count_text(body_after_interrupt, interrupt_marker) != 1:
                raise AssertionError(
                    f"Claude Esc turn should only show the user prompt marker unless Claude completes it; "
                    f"count={count_text(body_after_interrupt, interrupt_marker)}."
                )

            send_chat_message(page, recovery_prompt)
            body_after_recovery, recovery_permission_ids = wait_for_chat_text_count_with_permissions(
                page,
                base_url,
                resumed_session_id,
                recovery_marker,
                2,
                timeout_s=240,
            )
            assert_stop_absent(page)
            assert_claude_esc_available(page)
            assert_composer_ready(page)
            assert_interrupt_notice_count(body_after_recovery, 0)
            if count_text(body_after_recovery, recovery_marker) != 2:
                raise AssertionError(
                    f"Expected Claude recovery marker in exactly one user prompt and one assistant answer; "
                    f"count={count_text(body_after_recovery, recovery_marker)}."
                )

            send_chat_message(page, interrupt2_prompt)
            assert_stop_absent(page)
            assert_claude_esc_available(page)
            claude_esc_button(page).click(timeout=60_000)
            try:
                claude_esc_button(page).click(timeout=1000)
            except Exception:
                pass
            page.wait_for_timeout(1500)
            second_interrupt_state = request_json(base_url, f"/api/sessions/{resumed_session_id}")["session"]
            if second_interrupt_state["session"]["runtimeState"] in ("failed", "stopped"):
                raise AssertionError(
                    f"Claude second Esc flow ended in {second_interrupt_state['session']['runtimeState']}."
                )
            assert_stop_absent(page)
            assert_claude_esc_available(page)
            assert_composer_ready(page)
            body_after_second_interrupt = chat_text(page)
            assert_interrupt_notice_count(body_after_second_interrupt, 0)
            if count_text(body_after_second_interrupt, interrupt2_marker) != 1:
                raise AssertionError(
                    f"Second Claude Esc turn should only show the user prompt marker unless Claude completes it; "
                    f"count={count_text(body_after_second_interrupt, interrupt2_marker)}."
                )

            send_chat_message(page, recovery2_prompt)
            body_after_recovery2, recovery2_permission_ids = wait_for_chat_text_count_with_permissions(
                page,
                base_url,
                resumed_session_id,
                recovery2_marker,
                2,
                timeout_s=240,
            )
            assert_stop_absent(page)
            assert_claude_esc_available(page)
            assert_composer_ready(page)
            assert_interrupt_notice_count(body_after_recovery2, 0)
            if count_text(body_after_recovery2, recovery2_marker) != 2:
                raise AssertionError(
                    f"Expected Claude second recovery marker in exactly one user prompt and one assistant answer; "
                    f"count={count_text(body_after_recovery2, recovery2_marker)}."
                )
            socket_messages = page.evaluate("window.__rahSocketMessages")
            second_user_count, _turn_id = gather_matching_user_events(socket_messages, second_prompt)
            old_turn_count_after = count_text(body_after_second, first_marker)

            result = {
                "ok": True,
                "baseUrl": base_url,
                "provider": "claude",
                "browser": "chromium",
                "headless": True,
                "caseIds": REAL_BROWSER_CASE_IDS,
                "asserted": [
                    "real Claude provider path was used; no fake provider is created by this script",
                    "Claude TUI mux Chat is treated as a history mirror, not authoritative busy state",
                    "history replay shows the first real turn",
                    "claimed session accepts a second real browser chat turn",
                    "red Stop is absent for Claude TUI mux; yellow Esc is available",
                    "double Esc click does not close the session",
                    "Esc does not create synthetic Conversation interrupted chat notices",
                    "recovery turn after Esc reaches Claude",
                    "marker counts reject duplicate user/assistant bubbles",
                ],
                "providerSessionId": provider_session_id,
                "historyReplay": {
                    "recentCount": len(recent),
                    "storedCount": len(stored),
                    "oldTurnVisibleCount": old_turn_count_before,
                },
                "claimFlow": {
                    "matchingUserEventCount": second_user_count,
                    "oldTurnVisibleCountAfterClaim": old_turn_count_after,
                    "permissionCount": len(second_permission_ids)
                    + len(recovery_permission_ids)
                    + len(recovery2_permission_ids),
                },
                "firstMarker": first_marker,
                "secondMarker": second_marker,
                "escFlow": {
                    "escMarkerVisibleCount": count_text(body_after_recovery2, interrupt_marker),
                    "esc2MarkerVisibleCount": count_text(body_after_recovery2, interrupt2_marker),
                    "syntheticInterruptNoticeCount": count_text(body_after_recovery2, "Conversation interrupted"),
                    "recoveryMarkerVisibleCount": count_text(body_after_recovery2, recovery_marker),
                    "recovery2MarkerVisibleCount": count_text(body_after_recovery2, recovery2_marker),
                },
            }
            print(json.dumps(result, ensure_ascii=False, indent=2))
            assert_no_chat_noise(body_after_recovery2)
            assert_text_order(
                body_after_recovery2,
                second_prompt,
                second_marker,
                interrupt_prompt,
                recovery_prompt,
                recovery_marker,
                interrupt2_prompt,
                recovery2_prompt,
                recovery2_marker,
            )
            return 0
        except Exception as exc:
            try:
                body = page.locator("body").inner_text()
                visible_chat = chat_text(page)
                socket_messages = page.evaluate("window.__rahSocketMessages")
                canceled_events = []
                for batch in socket_messages:
                    events = batch.get("events") if isinstance(batch, dict) else None
                    if not isinstance(events, list):
                        continue
                    for event in events:
                        if isinstance(event, dict) and event.get("type") == "turn.canceled":
                            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
                            identity = payload.get("identity") if isinstance(payload.get("identity"), dict) else {}
                            canceled_events.append(
                                {
                                    "id": event.get("id"),
                                    "seq": event.get("seq"),
                                    "turnId": event.get("turnId"),
                                    "canonicalTurnId": identity.get("canonicalTurnId"),
                                    "ts": event.get("ts"),
                                }
                            )
                print(
                    json.dumps(
                        {
                            "provider": "claude",
                            "error": str(exc),
                            "bodySnippet": body[-2200:],
                            "chatSnippet": visible_chat[-2200:],
                            "socketMessageCount": len(socket_messages),
                            "canceledEvents": canceled_events,
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                    file=os.sys.stderr,
                )
            except Exception:
                pass
            raise
        finally:
            browser.close()
            if resumed_session_id:
                close_session(base_url, resumed_session_id, client_id)
            if replay_session_id:
                close_session(base_url, replay_session_id, client_id)
            if live_session_id:
                close_session(base_url, live_session_id)
            cleanup_smoke_workspace(base_url, workspace)


if __name__ == "__main__":
    raise SystemExit(main())
