from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import tempfile
import time
from dataclasses import dataclass
from typing import Any
from urllib import error, request

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import expect, sync_playwright

from rah_smoke_cleanup import cleanup_smoke_workspace


@dataclass(frozen=True)
class ProviderSmokeConfig:
    provider: str
    mode_id: str
    alpha_text: str
    beta_text: str
    gamma_text: str
    first_marker_prefix: str
    second_marker_prefix: str
    prompt_language: str
    model_id: str | None = None
    reasoning_id: str | None = None
    exercise_file_tools: bool = True
    require_file_outputs: bool = True
    require_tool_event: bool = True
    expect_exact_assistant_marker: bool = True


CONFIGS = {
    "codex": ProviderSmokeConfig(
        provider="codex",
        mode_id="never/danger-full-access",
        alpha_text="ALPHA-CODEX\n",
        beta_text="BETA-CODEX\n",
        gamma_text="GAMMA-CODEX\n",
        first_marker_prefix="CODEX-BROWSER-1",
        second_marker_prefix="CODEX-BROWSER-2",
        prompt_language="english",
        model_id="gpt-5.6-sol",
        reasoning_id="low",
    ),
    "opencode": ProviderSmokeConfig(
        provider="opencode",
        mode_id="build",
        alpha_text="ALPHA-OPENCODE\n",
        beta_text="BETA-OPENCODE\n",
        gamma_text="GAMMA-OPENCODE\n",
        first_marker_prefix="OPENCODE-BROWSER-1",
        second_marker_prefix="OPENCODE-BROWSER-2",
        prompt_language="english",
        exercise_file_tools=False,
        require_file_outputs=False,
        require_tool_event=False,
        expect_exact_assistant_marker=False,
    ),
}

REAL_BROWSER_CASE_IDS = [
    "REAL-PROVIDER-001",
    "REAL-CHAT-ORDER-001",
    "REAL-CHAT-UNIQUE-001",
    "REAL-STOP-NORMAL-IDLE-001",
    "REAL-INTERRUPT-ONCE-001",
    "REAL-INTERRUPT-RECOVERY-001",
    "REAL-INTERRUPT-MULTI-TURN-001",
    "REAL-HISTORY-REPLAY-001",
    "REAL-HISTORY-RESUME-001",
    "REAL-SECOND-TURN-001",
]

SCREENSHOTS: list[str] = []
INTERRUPT_NOTICE_PREFIX = "Interrupted after "


def artifact_dir(provider: str) -> pathlib.Path:
    raw = os.environ.get("RAH_BROWSER_E2E_ARTIFACT_DIR", "test-results/browser-e2e")
    root = pathlib.Path(raw)
    if not root.is_absolute():
        root = pathlib.Path(__file__).resolve().parent.parent / root
    path = root / "real-provider-browser" / provider / str(int(time.time()))
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_screenshot(page, directory: pathlib.Path, name: str) -> None:
    path = directory / f"{name}.png"
    page.screenshot(path=str(path), full_page=False)
    repo_root = pathlib.Path(__file__).resolve().parent.parent
    SCREENSHOTS.append(str(path.relative_to(repo_root) if path.is_relative_to(repo_root) else path))


def request_json(base_url: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    if payload is None:
        req = request.Request(f"{base_url}{path}")
    else:
        req = request.Request(
            f"{base_url}{path}",
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
        )
    try:
        with request.urlopen(req, timeout=240) as response:
            return json.load(response)
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{path} returned HTTP {exc.code}: {body}") from exc


def close_live_sessions(base_url: str, provider: str) -> None:
    sessions = request_json(base_url, "/api/sessions").get("sessions", [])
    for session in sessions:
        summary = session.get("session") if isinstance(session, dict) else None
        if not isinstance(summary, dict) or summary.get("provider") != provider:
            continue
        cwd = summary.get("cwd")
        if not isinstance(cwd, str) or not pathlib.Path(cwd).name.startswith(
            f"rah-{provider}-browser-"
        ):
            continue
        session_id = summary.get("id")
        if not isinstance(session_id, str):
            continue
        client_id = session.get("controlLease", {}).get("holderClientId") if isinstance(session, dict) else None
        attached_clients = session.get("attachedClients") if isinstance(session, dict) else None
        if not isinstance(client_id, str) and isinstance(attached_clients, list):
            for attached in attached_clients:
                if isinstance(attached, dict) and isinstance(attached.get("id"), str):
                    client_id = attached["id"]
                    break
        if not isinstance(client_id, str):
            client_id = f"{provider}-browser-smoke"
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
            client_id = "provider-browser-smoke"
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


def count_text(haystack: str, needle: str) -> int:
    count = 0
    start = 0
    while True:
        index = haystack.find(needle, start)
        if index == -1:
            return count
        count += 1
        start = index + len(needle)


def gather_matching_user_events(socket_messages: list[Any], token: str) -> tuple[int, str | None]:
    raw_count = 0
    unique_keys: set[str] = set()
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
                raw_count += 1
                payload_identity = payload.get("identity")
                identity_key = None
                if isinstance(payload_identity, dict):
                    canonical_item_id = payload_identity.get("canonicalItemId")
                    if isinstance(canonical_item_id, str):
                        identity_key = f"canonical:{canonical_item_id}"
                unique_keys.add(identity_key or f"event:{event.get('id')}")
                if isinstance(event.get("turnId"), str):
                    turn_id = event["turnId"]
    return len(unique_keys) if raw_count else 0, turn_id


def gather_assistant_events_for_turn(socket_messages: list[Any], turn_id: str | None) -> int:
    if turn_id is None:
        return 0
    unique_keys: set[str] = set()
    for batch in socket_messages:
        events = batch.get("events") if isinstance(batch, dict) else None
        if not isinstance(events, list):
            continue
        for event in events:
            if not isinstance(event, dict) or event.get("turnId") != turn_id:
                continue
            if event.get("type") != "timeline.item.added":
                continue
            payload = event.get("payload")
            if not isinstance(payload, dict):
                continue
            item = payload.get("item")
            if isinstance(item, dict) and item.get("kind") == "assistant_message":
                identity = payload.get("identity")
                identity = identity if isinstance(identity, dict) else {}
                canonical_item_id = identity.get("canonicalItemId")
                unique_keys.add(
                    f"canonical:{canonical_item_id}"
                    if isinstance(canonical_item_id, str)
                    else f"event:{event.get('id')}"
                )
    return len(unique_keys)


def gather_tool_names_for_turn(socket_messages: list[Any], turn_id: str | None) -> list[str]:
    if turn_id is None:
        return []
    names: list[str] = []
    for batch in socket_messages:
        events = batch.get("events") if isinstance(batch, dict) else None
        if not isinstance(events, list):
            continue
        for event in events:
            if not isinstance(event, dict) or event.get("turnId") != turn_id:
                continue
            if event.get("type") not in {"tool.call.started", "tool.call.completed"}:
                continue
            payload = event.get("payload")
            if not isinstance(payload, dict):
                continue
            tool_call = payload.get("toolCall")
            if not isinstance(tool_call, dict):
                continue
            name = tool_call.get("providerToolName") or tool_call.get("normalizedToolName")
            if isinstance(name, str):
                names.append(name)
    return sorted(set(names))


def summarize_conversation_events(socket_messages: list[Any]) -> list[dict[str, Any]]:
    summary: list[dict[str, Any]] = []
    for batch in socket_messages:
        events = batch.get("events") if isinstance(batch, dict) else None
        if not isinstance(events, list):
            continue
        for event in events:
            if not isinstance(event, dict):
                continue
            event_type = event.get("type")
            if event_type not in {
                "timeline.item.added",
                "turn.started",
                "turn.completed",
                "turn.canceled",
                "turn.failed",
            }:
                continue
            payload = event.get("payload")
            payload = payload if isinstance(payload, dict) else {}
            item = payload.get("item")
            item = item if isinstance(item, dict) else {}
            identity = payload.get("identity")
            identity = identity if isinstance(identity, dict) else {}
            text = item.get("text")
            summary.append(
                {
                    "type": event_type,
                    "turnId": event.get("turnId"),
                    "kind": item.get("kind"),
                    "text": text[:240] if isinstance(text, str) else None,
                    "canonicalItemId": identity.get("canonicalItemId"),
                    "source": payload.get("source"),
                    "error": payload.get("error"),
                    "reason": payload.get("reason"),
                }
            )
    return summary[-160:]


def summarize_conversation_snapshot(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    summary: list[dict[str, Any]] = []
    turns = snapshot.get("turns")
    if not isinstance(turns, list):
        return summary
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        users: list[str] = []
        assistants: list[str] = []
        items = turn.get("items")
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict):
                    continue
                content = item.get("content")
                if not isinstance(content, dict) or content.get("kind") != "timeline":
                    continue
                timeline = content.get("item")
                if not isinstance(timeline, dict):
                    continue
                text = timeline.get("text")
                if not isinstance(text, str):
                    continue
                if timeline.get("kind") == "user_message":
                    users.append(text[:240])
                elif timeline.get("kind") == "assistant_message":
                    assistants.append(text[:240])
        summary.append(
            {
                "id": turn.get("id"),
                "providerTurnId": turn.get("providerTurnId"),
                "status": turn.get("status"),
                "users": users,
                "assistants": assistants,
            }
        )
    return summary


def assert_canonical_turn_sequence(
    snapshot: dict[str, Any],
    expected: list[tuple[str, str, str | None]],
) -> None:
    turns = snapshot.get("turns")
    if not isinstance(turns, list):
        raise AssertionError("Conversation snapshot did not contain turns.")

    cursor = -1
    all_markers = [marker for _, _, marker in expected if marker is not None]
    for expected_user, expected_status, expected_assistant_marker in expected:
        matching_indexes: list[int] = []
        for index, turn in enumerate(turns):
            if not isinstance(turn, dict):
                continue
            items = turn.get("items")
            if not isinstance(items, list):
                continue
            user_texts: list[str] = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                content = item.get("content")
                if not isinstance(content, dict) or content.get("kind") != "timeline":
                    continue
                timeline = content.get("item")
                if (
                    isinstance(timeline, dict)
                    and timeline.get("kind") == "user_message"
                    and isinstance(timeline.get("text"), str)
                ):
                    user_texts.append(timeline["text"])
            if user_texts.count(expected_user) == 1:
                matching_indexes.append(index)
        if len(matching_indexes) != 1:
            raise AssertionError(
                f"Expected exactly one canonical turn for {expected_user!r}; "
                f"matching indexes={matching_indexes}."
            )
        index = matching_indexes[0]
        if index <= cursor:
            raise AssertionError(
                f"Canonical turn order regressed for {expected_user!r}: "
                f"index={index}, previous={cursor}."
            )
        turn = turns[index]
        assert isinstance(turn, dict)
        if turn.get("status") != expected_status:
            raise AssertionError(
                f"Canonical turn for {expected_user!r} has status {turn.get('status')!r}; "
                f"expected {expected_status!r}."
            )
        assistant_texts: list[str] = []
        items = turn.get("items")
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict):
                    continue
                content = item.get("content")
                if not isinstance(content, dict) or content.get("kind") != "timeline":
                    continue
                timeline = content.get("item")
                if (
                    isinstance(timeline, dict)
                    and timeline.get("kind") == "assistant_message"
                    and isinstance(timeline.get("text"), str)
                ):
                    assistant_texts.append(timeline["text"])
        assistant_text = "\n".join(assistant_texts)
        if expected_assistant_marker is not None and assistant_text.count(expected_assistant_marker) != 1:
            raise AssertionError(
                f"Canonical turn for {expected_user!r} did not contain exactly one matching assistant marker "
                f"{expected_assistant_marker!r}; assistants={assistant_texts!r}."
            )
        foreign_markers = [
            marker
            for marker in all_markers
            if marker != expected_assistant_marker and marker in assistant_text
        ]
        if foreign_markers:
            raise AssertionError(
                f"Canonical turn for {expected_user!r} contains assistant output from another turn: "
                f"{foreign_markers!r}; assistants={assistant_texts!r}."
            )
        cursor = index


def wait_for_session_match(
    base_url: str,
    predicate,
    *,
    timeout_s: int = 90,
) -> dict[str, Any]:
    started = time.time()
    while time.time() - started < timeout_s:
        sessions = request_json(base_url, "/api/sessions").get("sessions", [])
        for session in sessions:
            if predicate(session):
                return session
        time.sleep(1)
    raise TimeoutError("Timed out waiting for session match.")


def wait_for_recent_and_stored(
    base_url: str,
    provider: str,
    provider_session_id: str,
    *,
    timeout_s: int = 45,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    started = time.time()
    last_counts = (0, 0)
    while time.time() - started < timeout_s:
        response = request_json(base_url, "/api/sessions")
        recent = [
            item
            for item in response.get("recentSessions", [])
            if item.get("provider") == provider and item.get("providerSessionId") == provider_session_id
        ]
        stored = [
            item
            for item in response.get("storedSessions", [])
            if item.get("provider") == provider and item.get("providerSessionId") == provider_session_id
        ]
        last_counts = (len(recent), len(stored))
        if recent and stored:
            return recent, stored
        time.sleep(1)
    raise TimeoutError(
        f"{provider} session did not appear in Recent/Stored after close "
        f"(recent={last_counts[0]}, stored={last_counts[1]})."
    )


def wait_for_body_contains(page, text: str, *, timeout_s: int = 90) -> str:
    started = time.time()
    last = ""
    while time.time() - started < timeout_s:
        last = page.locator("body").inner_text()
        if text in last:
            return last
        page.wait_for_timeout(1000)
    raise TimeoutError(f"Timed out waiting for body to contain {text!r}. Last body snippet: {last[-1200:]}")


def wait_for_body_text_count(page, text: str, minimum: int, *, timeout_s: int = 90) -> str:
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


def wait_for_chat_text_count(page, text: str, minimum: int, *, timeout_s: int = 90) -> str:
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


def assert_visible_once(body: str, text: str, label: str) -> None:
    count = count_text(body, text)
    if count != 1:
        raise AssertionError(f"Expected exactly one visible {label}, saw {count}. Body tail: {body[-1600:]}")


def wait_for_assistant_event_for_prompt(
    page,
    prompt_text: str,
    *,
    timeout_s: int = 90,
) -> tuple[int, str | None, int]:
    started = time.time()
    last_user_count = 0
    last_turn_id = None
    last_assistant_count = 0
    while time.time() - started < timeout_s:
        socket_messages = page.evaluate("window.__rahSocketMessages")
        last_user_count, last_turn_id = gather_matching_user_events(socket_messages, prompt_text)
        last_assistant_count = gather_assistant_events_for_turn(socket_messages, last_turn_id)
        if last_user_count == 1 and last_assistant_count >= 1:
            return last_user_count, last_turn_id, last_assistant_count
        page.wait_for_timeout(1000)
    raise TimeoutError(
        f"Timed out waiting for assistant event for prompt. "
        f"userCount={last_user_count} turnId={last_turn_id} assistantCount={last_assistant_count}"
    )


def stop_button(page):
    return page.get_by_role("button", name="Stop generating")


def send_button(page):
    return page.get_by_role("button", name="Send message").last


def visible_composer(page):
    return page.locator("textarea:visible").last


def assert_stop_absent(page, *, timeout_s: int = 45) -> None:
    expect(stop_button(page)).to_have_count(0, timeout=timeout_s * 1000)


def assert_composer_ready(page, *, timeout_s: int = 45) -> None:
    composer = visible_composer(page)
    expect(composer).to_be_visible(timeout=timeout_s * 1000)
    expect(composer).to_be_enabled(timeout=timeout_s * 1000)


def elapsed_ms(started_at: float) -> float:
    return round((time.perf_counter() - started_at) * 1000, 1)


def wait_for_new_session_chat(page, title: str, *, timeout_s: int = 90) -> None:
    session_button = page.locator("button").filter(has_text=title).first
    expect(session_button).to_be_visible(timeout=timeout_s * 1000)
    session_button.click()
    expect(page.get_by_role("button", name="Stop session")).to_be_visible(
        timeout=timeout_s * 1000
    )
    composer = page.locator("textarea:visible").last
    expect(composer).to_be_visible(timeout=timeout_s * 1000)
    expect(composer).to_be_enabled(timeout=timeout_s * 1000)


def stop_session_from_header(page, *, timeout_s: int = 90) -> float:
    started_at = time.perf_counter()
    stop_button = page.get_by_role("button", name="Stop session")
    expect(stop_button).to_be_visible(timeout=timeout_s * 1000)
    expect(stop_button).to_be_enabled(timeout=timeout_s * 1000)
    stop_button.click()

    dialog = page.get_by_role("dialog").filter(has_text="Stop session?")
    expect(dialog).to_be_visible(timeout=timeout_s * 1000)
    dialog.get_by_role("button", name="Stop", exact=True).click()
    expect(dialog).not_to_be_visible(timeout=timeout_s * 1000)
    expect(stop_button).not_to_be_visible(timeout=timeout_s * 1000)
    duration_ms = elapsed_ms(started_at)

    chats_button = page.locator('button[aria-label="Chats"]:visible').first
    expect(chats_button).to_be_enabled(timeout=timeout_s * 1000)
    chats_button.click()
    expect(page.get_by_role("tab", name="Recent", exact=True)).to_be_visible(
        timeout=timeout_s * 1000
    )
    page.keyboard.press("Escape")
    return duration_ms


def send_chat_message(page, text: str) -> None:
    composer = visible_composer(page)
    expect(composer).to_be_visible(timeout=90_000)
    expect(composer).to_be_enabled(timeout=45_000)
    composer.fill(text)
    expect(send_button(page)).to_be_enabled(timeout=45_000)
    page.keyboard.press("Enter")


def interrupt_prompt(config: ProviderSmokeConfig, marker: str) -> str:
    return (
        "Use the available shell tool to run a command that sleeps for 20 seconds. "
        f"Only after the sleep finishes, reply exactly {marker}. "
        "This turn is part of a real browser interruption test."
    )


def recovery_prompt(config: ProviderSmokeConfig, marker: str) -> str:
    return (
        "The previous interrupted instruction is canceled and must not be resumed. "
        "Do not run its tool call. Reply immediately with exactly this marker and no extra text: "
        f"{marker}"
    )


def assert_interrupt_notice_count(body: str, expected: int) -> None:
    count = count_text(body, INTERRUPT_NOTICE_PREFIX)
    if count != expected:
        raise AssertionError(
            f"Expected exactly {expected} interrupt notice(s), saw {count}. Body tail: {body[-1600:]}"
        )
    if "Failed after " in body:
        raise AssertionError(
            f"An interrupted turn must not also render as failed. Body tail: {body[-1600:]}"
        )


def choose_allow_action(request_payload: dict[str, Any]) -> str:
    actions = request_payload.get("actions")
    if isinstance(actions, list):
        for preferred in ("allow_for_session", "approve_for_session", "always"):
            for action in actions:
                if isinstance(action, dict) and action.get("id") == preferred:
                    return preferred
        for action in actions:
            if not isinstance(action, dict):
                continue
            action_id = action.get("id")
            behavior = action.get("behavior")
            if isinstance(action_id, str) and behavior == "allow":
                return action_id
    return "allow_for_session"


def wait_for_idle_with_auto_permissions(
    page,
    base_url: str,
    session_id: str,
    prompt_text: str,
    *,
    timeout_s: int = 300,
) -> tuple[dict[str, Any], list[str]]:
    started = time.time()
    handled: set[str] = set()
    seen_request_ids: list[str] = []
    last: dict[str, Any] | None = None

    while time.time() - started < timeout_s:
        socket_messages = page.evaluate("window.__rahSocketMessages")
        matching_user_count, _turn_id = gather_matching_user_events(
            socket_messages,
            prompt_text,
        )
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
                selected_action_id = choose_allow_action(request_payload)
                request_json(
                    base_url,
                    f"/api/sessions/{session_id}/permissions/{request_id}/respond",
                    {
                        "behavior": "allow",
                        "selectedActionId": selected_action_id,
                        "decision": "approved_for_session",
                    },
                )
                handled.add(request_id)
                seen_request_ids.append(request_id)

        last = request_json(base_url, f"/api/sessions/{session_id}")["session"]
        if (
            matching_user_count > 0
            and last["session"]["runtimeState"] in ("idle", "failed", "stopped")
        ):
            return last, seen_request_ids
        time.sleep(1)

    try:
        canonical = request_json(
            base_url,
            f"/api/sessions/{session_id}/conversation/turns?limit=20",
        )
    except Exception as error:
        canonical = {"error": str(error)}
    socket_summary = summarize_conversation_events(
        page.evaluate("window.__rahSocketMessages")
    )
    raise TimeoutError(
        f"Timed out waiting for {session_id}; last={last}; "
        f"canonical={summarize_conversation_snapshot(canonical)}; "
        f"socketEvents={socket_summary}"
    )


def deterministic_session_config(config: ProviderSmokeConfig) -> dict[str, Any]:
    return {
        **({"model": config.model_id} if config.model_id else {}),
        **(
            {"optionValues": {"model_reasoning_effort": config.reasoning_id}}
            if config.reasoning_id
            else {}
        ),
    }


def first_prompt(config: ProviderSmokeConfig, marker: str) -> str:
    if not config.exercise_file_tools:
        return (
            "Reply immediately with exactly this marker and no extra text: "
            f"{marker}"
        )
    return (
        "Use the available file tools or shell commands. Read alpha.txt. "
        f"Then create beta.txt containing exactly {config.beta_text.strip()} on one line. "
        f"Finally answer with exactly {marker}. Do not repeat any other text."
    )


def second_prompt(config: ProviderSmokeConfig, marker: str) -> str:
    if not config.exercise_file_tools:
        return (
            "Reply immediately with exactly this marker and no extra text: "
            f"{marker}"
        )
    return (
        "Use the available file tools or shell commands. Read beta.txt. "
        f"Then create gamma.txt containing exactly {config.gamma_text.strip()} on one line. "
        f"Finally answer with exactly {marker}. Do not repeat any other text."
    )


def live_backend_for_provider(provider: str) -> str:
    if provider in {"codex", "opencode"}:
        return "native_local_server"
    return "native_tui"


def assert_no_environment_leak(body: str) -> None:
    if "<environment_context>" in body:
        raise AssertionError("Environment context leaked into the chat UI.")


def assert_no_chat_noise(body: str) -> None:
    for needle in ("Loading older history", "Unhandled provider event", "Action failed"):
        if needle in body:
            raise AssertionError(f"Unexpected chat noise: {needle}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("provider", choices=sorted(CONFIGS))
    args = parser.parse_args()
    config = CONFIGS[args.provider]

    base_url = os.environ.get("RAH_BASE_URL", "http://127.0.0.1:43111")
    close_live_sessions(base_url, config.provider)

    workspace = pathlib.Path(tempfile.mkdtemp(prefix=f"rah-{config.provider}-browser-"))
    alpha = workspace / "alpha.txt"
    beta = workspace / "beta.txt"
    gamma = workspace / "gamma.txt"
    alpha.write_text(config.alpha_text, encoding="utf-8")

    token = str(int(time.time()))
    first_marker = f"{config.first_marker_prefix}-{token}"
    second_marker = f"{config.second_marker_prefix}-{token}"
    interrupt_marker = f"{config.first_marker_prefix}-INTERRUPT-{token}"
    recovery_marker = f"{config.second_marker_prefix}-RECOVERY-{token}"
    interrupt2_marker = f"{config.first_marker_prefix}-INTERRUPT2-{token}"
    recovery2_marker = f"{config.second_marker_prefix}-RECOVERY2-{token}"
    rapid1_marker = f"{config.first_marker_prefix}-RAPID1-{token}"
    rapid2_marker = f"{config.second_marker_prefix}-RAPID2-{token}"
    first_text = first_prompt(config, first_marker)
    second_text = second_prompt(config, second_marker)
    interrupt_text = interrupt_prompt(config, interrupt_marker)
    recovery_text = recovery_prompt(config, recovery_marker)
    interrupt2_text = interrupt_prompt(config, interrupt2_marker)
    recovery2_text = recovery_prompt(config, recovery2_marker)
    rapid1_text = recovery_prompt(config, rapid1_marker)
    rapid2_text = recovery_prompt(config, rapid2_marker)
    session_title = f"RAH {config.provider} browser smoke {token}"
    timings_ms: dict[str, float] = {}

    request_json(base_url, "/api/workspaces/add", {"dir": str(workspace)})
    request_json(base_url, "/api/workspaces/select", {"dir": str(workspace)})
    screenshots_dir = artifact_dir(config.provider)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 960})
        api_request_urls: list[str] = []
        page.on(
            "request",
            lambda next_request: api_request_urls.append(next_request.url)
            if "/api/" in next_request.url
            else None,
        )
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
        client_id = f"{config.provider}-browser-seed-{token}"

        try:
            page.goto(base_url, wait_until="domcontentloaded")
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(1500)

            new_session_started_at = time.perf_counter()
            seeded = request_json(
                base_url,
                "/api/sessions/start",
                {
                    "provider": config.provider,
                    "cwd": str(workspace),
                    "title": session_title,
                    "liveBackend": live_backend_for_provider(config.provider),
                    "modeId": config.mode_id,
                    **deterministic_session_config(config),
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
            wait_for_new_session_chat(page, session_title)
            timings_ms["newSessionToChatReady"] = elapsed_ms(new_session_started_at)
            input_client_id = resolve_control_client_id(base_url, live_session_id, client_id)
            request_json(
                base_url,
                f"/api/sessions/{live_session_id}/input",
                {"clientId": input_client_id, "text": first_text},
            )
            first_done, first_permission_ids = wait_for_idle_with_auto_permissions(
                page,
                base_url,
                live_session_id,
                first_text,
            )
            if first_done["session"]["runtimeState"] == "failed":
                raise AssertionError(f"{config.provider} seed flow failed: {first_done['session']}")
            provider_session_id = first_done["session"].get("providerSessionId")
            if not isinstance(provider_session_id, str) or not provider_session_id:
                raise AssertionError(f"{config.provider} seed flow did not publish providerSessionId.")
            beta_content = beta.read_text(encoding="utf-8") if beta.exists() else None
            if config.require_file_outputs and (
                beta_content is None or beta_content.strip() != config.beta_text.strip()
            ):
                raise AssertionError(
                    f"{config.provider} seed flow did not create beta.txt correctly: {beta_content!r}"
                )
            close_session(base_url, live_session_id, input_client_id)
            live_session_id = None
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(1500)

            recent, stored = wait_for_recent_and_stored(
                base_url,
                config.provider,
                provider_session_id,
            )

            page.locator('button[aria-label="Chats"]:visible').first.click()
            page.get_by_role("tab", name="Recent", exact=True).click()
            history_open_started_at = time.perf_counter()
            page.locator(
                f'button[data-provider-session-id="{provider_session_id}"]:visible'
            ).first.click()

            replay = wait_for_session_match(
                base_url,
                lambda item: item["session"]["provider"] == config.provider
                and item["session"].get("providerSessionId") == provider_session_id
                and item["session"]["capabilities"]["steerInput"] is False,
                timeout_s=90,
            )
            replay_session_id = replay["session"]["id"]
            expect(page.get_by_text("History only", exact=True)).to_be_visible(timeout=60_000)
            body_after_replay = wait_for_chat_contains(page, first_marker, timeout_s=90)
            timings_ms["historyOpenToReadable"] = elapsed_ms(history_open_started_at)
            if count_text(body_after_replay, first_marker) < 1:
                raise AssertionError(f"{config.provider} history replay did not show the first turn marker.")
            assert_no_environment_leak(body_after_replay)
            assert_no_chat_noise(body_after_replay)
            save_screenshot(page, screenshots_dir, f"{config.provider}-real-history-replay")

            claim_button = page.get_by_role("button", name="Resume", exact=True)
            expect(claim_button).to_be_visible(timeout=30_000)
            expect(claim_button).to_be_enabled(timeout=30_000)
            resume_request_start = len(api_request_urls)
            resume_started_at = time.perf_counter()
            with page.expect_response(
                lambda response: response.url.endswith("/api/sessions/resume"),
                timeout=30_000,
            ) as claim_response_info:
                claim_button.click()
            claim_response = claim_response_info.value
            claim_response_text = claim_response.text() if claim_response.status >= 400 else ""
            if claim_response.status >= 400 and "attach instead of resume" not in claim_response_text:
                raise AssertionError(
                    f"{config.provider} claim resume failed with HTTP {claim_response.status}: "
                    f"{claim_response_text}"
                )
            composer = page.locator("textarea:visible").last
            expect(composer).to_be_visible(timeout=90_000)
            resume_history_requests = [
                url
                for url in api_request_urls[resume_request_start:]
                if "/conversation/turns" in url
            ]
            if resume_history_requests:
                raise AssertionError(
                    f"{config.provider} Resume reloaded an already-visible Conversation page: "
                    f"{resume_history_requests}"
                )

            resumed = wait_for_session_match(
                base_url,
                lambda item: item["session"]["provider"] == config.provider
                and item["session"].get("providerSessionId") == provider_session_id
                and item["session"]["capabilities"]["steerInput"] is True,
                timeout_s=90,
            )
            resumed_session_id = resumed["session"]["id"]

            old_turn_count_before = count_text(chat_text(page), first_text)
            if old_turn_count_before < 1:
                raise AssertionError(
                    f"{config.provider} Resume hid the already-visible history turn."
                )
            assert_composer_ready(page, timeout_s=90)
            timings_ms["resumeToUsableChat"] = elapsed_ms(resume_started_at)

            composer.fill(second_text)
            page.keyboard.press("Enter")

            second_done, second_permission_ids = wait_for_idle_with_auto_permissions(
                page,
                base_url,
                resumed_session_id,
                second_text,
            )
            if second_done["session"]["runtimeState"] == "failed":
                raise AssertionError(f"{config.provider} claim flow failed: {second_done['session']}")
            body_after_second = (
                wait_for_chat_text_count(page, second_marker, 2, timeout_s=240)
                if config.expect_exact_assistant_marker
                else wait_for_chat_contains(page, second_text, timeout_s=240)
            )
            assert_stop_absent(page)
            assert_composer_ready(page)
            if config.expect_exact_assistant_marker and count_text(body_after_second, second_marker) != 2:
                raise AssertionError(
                    f"Expected one visible user prompt and one visible assistant answer for {config.provider}; "
                    f"marker count={count_text(body_after_second, second_marker)}."
                )
            if not config.expect_exact_assistant_marker:
                assert_visible_once(body_after_second, second_text, f"{config.provider} second user prompt")
                wait_for_assistant_event_for_prompt(page, second_text, timeout_s=90)

            send_chat_message(page, interrupt_text)
            expect(stop_button(page)).to_be_visible(timeout=60_000)
            stop_button(page).last.click()
            try:
                stop_button(page).last.click(timeout=1000)
            except Exception:
                pass
            interrupt_done, _interrupt_permissions = wait_for_idle_with_auto_permissions(
                page,
                base_url,
                resumed_session_id,
                interrupt_text,
                timeout_s=180,
            )
            if interrupt_done["session"]["runtimeState"] in ("failed", "stopped"):
                raise AssertionError(
                    f"{config.provider} interrupt flow ended in {interrupt_done['session']['runtimeState']}: "
                    f"{interrupt_done['session']}"
                )
            assert_stop_absent(page)
            assert_composer_ready(page)
            body_after_interrupt = chat_text(page)
            assert_interrupt_notice_count(body_after_interrupt, 1)
            if count_text(body_after_interrupt, interrupt_marker) != 1:
                raise AssertionError(
                    f"Interrupted {config.provider} turn should only show the user prompt marker once; "
                    f"count={count_text(body_after_interrupt, interrupt_marker)}."
                )

            send_chat_message(page, recovery_text)
            recovery_done, _recovery_permissions = wait_for_idle_with_auto_permissions(
                page,
                base_url,
                resumed_session_id,
                recovery_text,
                timeout_s=240,
            )
            if recovery_done["session"]["runtimeState"] == "failed":
                raise AssertionError(f"{config.provider} recovery flow failed: {recovery_done['session']}")
            body_after_recovery = (
                wait_for_chat_text_count(page, recovery_marker, 2, timeout_s=240)
                if config.expect_exact_assistant_marker
                else wait_for_chat_contains(page, recovery_text, timeout_s=240)
            )
            assert_stop_absent(page)
            assert_composer_ready(page)
            assert_interrupt_notice_count(body_after_recovery, 1)
            if config.expect_exact_assistant_marker and count_text(body_after_recovery, recovery_marker) != 2:
                raise AssertionError(
                    f"Expected one visible user prompt and one visible assistant answer for {config.provider} recovery; "
                    f"marker count={count_text(body_after_recovery, recovery_marker)}."
                )
            if not config.expect_exact_assistant_marker:
                assert_visible_once(body_after_recovery, recovery_text, f"{config.provider} recovery user prompt")
                wait_for_assistant_event_for_prompt(page, recovery_text, timeout_s=90)

            send_chat_message(page, interrupt2_text)
            expect(stop_button(page)).to_be_visible(timeout=60_000)
            stop_button(page).last.click()
            try:
                stop_button(page).last.click(timeout=1000)
            except Exception:
                pass
            second_interrupt_done, _second_interrupt_permissions = wait_for_idle_with_auto_permissions(
                page,
                base_url,
                resumed_session_id,
                interrupt2_text,
                timeout_s=180,
            )
            if second_interrupt_done["session"]["runtimeState"] in ("failed", "stopped"):
                raise AssertionError(
                    f"{config.provider} second interrupt flow ended in {second_interrupt_done['session']['runtimeState']}: "
                    f"{second_interrupt_done['session']}"
                )
            assert_stop_absent(page)
            assert_composer_ready(page)
            body_after_second_interrupt = chat_text(page)
            assert_interrupt_notice_count(body_after_second_interrupt, 2)
            if count_text(body_after_second_interrupt, interrupt2_marker) != 1:
                raise AssertionError(
                    f"Second interrupted {config.provider} turn should only show the user prompt marker once; "
                    f"count={count_text(body_after_second_interrupt, interrupt2_marker)}."
                )

            send_chat_message(page, recovery2_text)
            second_recovery_done, _second_recovery_permissions = wait_for_idle_with_auto_permissions(
                page,
                base_url,
                resumed_session_id,
                recovery2_text,
                timeout_s=240,
            )
            if second_recovery_done["session"]["runtimeState"] == "failed":
                raise AssertionError(
                    f"{config.provider} second recovery flow failed: {second_recovery_done['session']}"
                )
            body_after_recovery2 = (
                wait_for_chat_text_count(page, recovery2_marker, 2, timeout_s=240)
                if config.expect_exact_assistant_marker
                else wait_for_chat_contains(page, recovery2_text, timeout_s=240)
            )
            assert_stop_absent(page)
            assert_composer_ready(page)
            assert_interrupt_notice_count(body_after_recovery2, 2)
            if config.expect_exact_assistant_marker and count_text(body_after_recovery2, recovery2_marker) != 2:
                raise AssertionError(
                    f"Expected one visible user prompt and one visible assistant answer for {config.provider} second recovery; "
                    f"marker count={count_text(body_after_recovery2, recovery2_marker)}."
                )
            if not config.expect_exact_assistant_marker:
                assert_visible_once(body_after_recovery2, recovery2_text, f"{config.provider} second recovery user prompt")
                wait_for_assistant_event_for_prompt(page, recovery2_text, timeout_s=90)

            rapid_flow: dict[str, Any] | None = None
            if config.provider == "opencode":
                send_chat_message(page, rapid1_text)
                expect(stop_button(page)).to_be_visible(timeout=60_000)
                send_chat_message(page, rapid2_text)
                rapid1_user_count, rapid1_turn_id, rapid1_assistant_count = (
                    wait_for_assistant_event_for_prompt(page, rapid1_text, timeout_s=180)
                )
                rapid2_user_count, rapid2_turn_id, rapid2_assistant_count = (
                    wait_for_assistant_event_for_prompt(page, rapid2_text, timeout_s=180)
                )
                wait_for_idle_with_auto_permissions(
                    page,
                    base_url,
                    resumed_session_id,
                    rapid2_text,
                    timeout_s=180,
                )
                rapid_body = chat_text(page)
                assert_visible_once(rapid_body, rapid1_text, "OpenCode rapid first user prompt")
                assert_visible_once(rapid_body, rapid2_text, "OpenCode rapid second user prompt")
                if rapid1_turn_id == rapid2_turn_id:
                    raise AssertionError("Rapid OpenCode prompts were assigned to the same canonical turn.")
                if (rapid1_user_count, rapid1_assistant_count) != (1, 1):
                    raise AssertionError(
                        "Rapid OpenCode first turn was not unique: "
                        f"user={rapid1_user_count} assistant={rapid1_assistant_count}."
                    )
                if (rapid2_user_count, rapid2_assistant_count) != (1, 1):
                    raise AssertionError(
                        "Rapid OpenCode second turn was not unique: "
                        f"user={rapid2_user_count} assistant={rapid2_assistant_count}."
                    )
                rapid_flow = {
                    "firstTurnId": rapid1_turn_id,
                    "secondTurnId": rapid2_turn_id,
                    "firstUserCount": rapid1_user_count,
                    "firstAssistantCount": rapid1_assistant_count,
                    "secondUserCount": rapid2_user_count,
                    "secondAssistantCount": rapid2_assistant_count,
                }
            save_screenshot(page, screenshots_dir, f"{config.provider}-real-claim-response")
            socket_messages = page.evaluate("window.__rahSocketMessages")
            canonical_snapshot = request_json(
                base_url,
                f"/api/sessions/{resumed_session_id}/conversation/turns?limit=100",
            )
            second_user_count, second_turn_id = gather_matching_user_events(socket_messages, second_text)
            second_assistant_count = gather_assistant_events_for_turn(socket_messages, second_turn_id)
            second_tool_names = gather_tool_names_for_turn(socket_messages, second_turn_id)
            old_turn_count_after = count_text(body_after_second, first_text)

            gamma_content = gamma.read_text(encoding="utf-8") if gamma.exists() else None
            timings_ms["stopToUsableUi"] = stop_session_from_header(page)

            result = {
                "ok": True,
                "baseUrl": base_url,
                "provider": config.provider,
                "browser": "chromium",
                "headless": True,
                "timingsMs": timings_ms,
                "caseIds": REAL_BROWSER_CASE_IDS,
                "asserted": [
                    "real provider binary/server path was used; no fake provider is created by this script",
                    "history replay shows the first real turn",
                    "claimed session accepts a second real browser chat turn",
                    "Stop disappears after normal completion",
                    "double Stop click does not close the session",
                    "interrupt notice appears once",
                    "recovery turn after interrupt reaches the provider",
                    "marker counts reject duplicate user/assistant bubbles",
                ],
                "providerSessionId": provider_session_id,
                "screenshots": SCREENSHOTS,
                "seedFlow": {
                    "permissionCount": len(first_permission_ids),
                    "betaContent": beta_content,
                },
                "historyReplay": {
                    "replaySessionId": replay_session_id,
                    "recentCount": len(recent),
                    "storedCount": len(stored),
                    "oldTurnVisibleCount": old_turn_count_before,
                },
                "claimFlow": {
                    "resumedSessionId": resumed_session_id,
                    "matchingUserEventCount": second_user_count,
                    "assistantEventCount": second_assistant_count,
                    "toolNames": second_tool_names,
                    "permissionCount": len(second_permission_ids),
                    "oldTurnVisibleCountAfterClaim": old_turn_count_after,
                    "historyReloadRequestCount": len(resume_history_requests),
                },
                "gammaContent": gamma_content,
                "canonicalTurns": summarize_conversation_snapshot(canonical_snapshot),
                "interruptFlow": {
                    "interruptMarkerVisibleCount": count_text(body_after_recovery2, interrupt_marker),
                    "interrupt2MarkerVisibleCount": count_text(body_after_recovery2, interrupt2_marker),
                    "interruptNoticeCount": count_text(body_after_recovery2, INTERRUPT_NOTICE_PREFIX),
                    "recoveryMarkerVisibleCount": count_text(body_after_recovery2, recovery_marker),
                    "recovery2MarkerVisibleCount": count_text(body_after_recovery2, recovery2_marker),
                },
                **({"rapidFlow": rapid_flow} if rapid_flow is not None else {}),
            }
            assert_no_environment_leak(body_after_recovery2)
            assert_no_chat_noise(body_after_recovery2)
            expected_turns = [
                (second_text, "completed", second_marker),
                (interrupt_text, "interrupted", None),
                (recovery_text, "completed", recovery_marker),
                (interrupt2_text, "interrupted", None),
                (recovery2_text, "completed", recovery2_marker),
            ]
            if config.provider == "opencode":
                expected_turns.extend(
                    [
                        (rapid1_text, "completed", rapid1_marker),
                        (rapid2_text, "completed", rapid2_marker),
                    ]
                )
            assert_canonical_turn_sequence(canonical_snapshot, expected_turns)
            if second_assistant_count < 1:
                raise AssertionError(f"Expected at least one assistant event for the claimed {config.provider} turn.")
            if config.require_tool_event and len(second_tool_names) < 1:
                raise AssertionError(f"Expected at least one tool event for the claimed {config.provider} turn.")
            if not config.require_tool_event and len(second_tool_names) < 1:
                print(
                    json.dumps(
                        {
                            "provider": config.provider,
                            "warning": "No tool event observed for claimed turn; UI ordering and live resume were verified.",
                            "turnId": second_turn_id,
                        },
                        ensure_ascii=False,
                    ),
                    file=sys.stderr,
                )
            if old_turn_count_after > old_turn_count_before:
                raise AssertionError(f"Resuming {config.provider} history replayed older history into the UI.")

            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        except (AssertionError, PlaywrightTimeoutError) as exc:
            try:
                save_screenshot(page, screenshots_dir, f"{config.provider}-real-failure")
                body = page.locator("body").inner_text()
                visible_chat = chat_text(page)
                socket_messages = page.evaluate("window.__rahSocketMessages")
                conversation_snapshot = (
                    request_json(
                        base_url,
                        f"/api/sessions/{resumed_session_id}/conversation/turns?limit=100",
                    )
                    if resumed_session_id
                    else {}
                )
                print(
                    json.dumps(
                        {
                            "provider": config.provider,
                            "error": str(exc),
                            "bodySnippet": body[-1600:],
                            "chatSnippet": visible_chat[-1600:],
                            "socketMessageCount": len(socket_messages),
                            "conversationEvents": summarize_conversation_events(socket_messages),
                            "conversationSnapshot": summarize_conversation_snapshot(
                                conversation_snapshot
                            ),
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
            if resumed_session_id:
                close_session(base_url, resumed_session_id)
            if replay_session_id:
                close_session(base_url, replay_session_id)
            if live_session_id:
                close_session(base_url, live_session_id)
            cleanup_smoke_workspace(base_url, workspace)


if __name__ == "__main__":
    raise SystemExit(main())
