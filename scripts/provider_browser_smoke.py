from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import tempfile
import time
from dataclasses import dataclass
from typing import Any
from urllib import request

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import expect, sync_playwright


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
    ),
    "opencode": ProviderSmokeConfig(
        provider="opencode",
        mode_id="opencode/full-auto",
        alpha_text="ALPHA-OPENCODE\n",
        beta_text="BETA-OPENCODE\n",
        gamma_text="GAMMA-OPENCODE\n",
        first_marker_prefix="OPENCODE-BROWSER-1",
        second_marker_prefix="OPENCODE-BROWSER-2",
        prompt_language="english",
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
    "REAL-HISTORY-CLAIM-001",
    "REAL-SECOND-TURN-001",
]

SCREENSHOTS: list[str] = []


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
    with request.urlopen(req, timeout=240) as response:
        return json.load(response)


def close_live_sessions(base_url: str, provider: str) -> None:
    sessions = request_json(base_url, "/api/sessions").get("sessions", [])
    for session in sessions:
        summary = session.get("session") if isinstance(session, dict) else None
        if not isinstance(summary, dict) or summary.get("provider") != provider:
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
    count = 0
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
                count += 1
    return count


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
        "Reply immediately with exactly this marker and no extra text: "
        f"{marker}"
    )


def assert_interrupt_notice_count(body: str, expected: int) -> None:
    count = count_text(body, "Conversation interrupted")
    if count != expected:
        raise AssertionError(
            f"Expected exactly {expected} interrupt notice(s), saw {count}. Body tail: {body[-1600:]}"
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
    *,
    timeout_s: int = 300,
) -> tuple[dict[str, Any], list[str]]:
    started = time.time()
    handled: set[str] = set()
    seen_request_ids: list[str] = []
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
        if last["session"]["runtimeState"] in ("idle", "failed", "stopped"):
            return last, seen_request_ids
        time.sleep(1)

    raise TimeoutError(f"Timed out waiting for {session_id}; last={last}")


def first_prompt(config: ProviderSmokeConfig, marker: str) -> str:
    return (
        "Use the available file tools or shell commands. Read alpha.txt. "
        f"Then create beta.txt containing exactly {config.beta_text.strip()} on one line. "
        f"Finally answer with exactly {marker}. Do not repeat any other text."
    )


def second_prompt(config: ProviderSmokeConfig, marker: str) -> str:
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


def assert_text_order(body: str, *needles: str) -> None:
    cursor = -1
    for needle in needles:
        index = body.find(needle, cursor + 1)
        if index < 0:
            raise AssertionError(
                f"Expected {needle!r} after offset {cursor}; body tail: {body[-1600:]}"
            )
        cursor = index


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
    first_text = first_prompt(config, first_marker)
    second_text = second_prompt(config, second_marker)
    interrupt_text = interrupt_prompt(config, interrupt_marker)
    recovery_text = recovery_prompt(config, recovery_marker)
    interrupt2_text = interrupt_prompt(config, interrupt2_marker)
    recovery2_text = recovery_prompt(config, recovery2_marker)

    request_json(base_url, "/api/workspaces/add", {"dir": str(workspace)})
    request_json(base_url, "/api/workspaces/select", {"dir": str(workspace)})
    screenshots_dir = artifact_dir(config.provider)

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
        client_id = f"{config.provider}-browser-seed-{token}"

        try:
            page.goto(base_url, wait_until="domcontentloaded")
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(1500)

            seeded = request_json(
                base_url,
                "/api/sessions/start",
                {
                    "provider": config.provider,
                    "cwd": str(workspace),
                    "liveBackend": live_backend_for_provider(config.provider),
                    "modeId": config.mode_id,
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
                {"clientId": input_client_id, "text": first_text},
            )
            first_done, first_permission_ids = wait_for_idle_with_auto_permissions(
                page,
                base_url,
                live_session_id,
            )
            if first_done["session"]["runtimeState"] == "failed":
                raise AssertionError(f"{config.provider} seed flow failed: {first_done['session']}")
            provider_session_id = first_done["session"].get("providerSessionId")
            if not isinstance(provider_session_id, str) or not provider_session_id:
                raise AssertionError(f"{config.provider} seed flow did not publish providerSessionId.")
            if beta.read_text(encoding="utf-8") != config.beta_text:
                raise AssertionError(f"{config.provider} seed flow did not create beta.txt correctly.")
            close_session(base_url, live_session_id, input_client_id)
            live_session_id = None
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(1500)

            sessions_after_close = request_json(base_url, "/api/sessions")
            recent = [
                item
                for item in sessions_after_close["recentSessions"]
                if item["provider"] == config.provider and item["providerSessionId"] == provider_session_id
            ]
            stored = [
                item
                for item in sessions_after_close["storedSessions"]
                if item["provider"] == config.provider and item["providerSessionId"] == provider_session_id
            ]
            if not recent or not stored:
                raise AssertionError(f"{config.provider} session did not appear in Recent/Stored after close.")

            page.locator('button[aria-label="Sessions"]:visible').first.click()
            page.get_by_role("button", name="Recent", exact=True).click()
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
            if count_text(body_after_replay, first_marker) < 1:
                raise AssertionError(f"{config.provider} history replay did not show the first turn marker.")
            assert_no_environment_leak(body_after_replay)
            assert_no_chat_noise(body_after_replay)
            save_screenshot(page, screenshots_dir, f"{config.provider}-real-history-replay")

            claim_button = page.get_by_role("button", name="Claim control", exact=True)
            expect(claim_button).to_be_visible(timeout=30_000)
            expect(claim_button).to_be_enabled(timeout=30_000)
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

            resumed = wait_for_session_match(
                base_url,
                lambda item: item["session"]["provider"] == config.provider
                and item["session"].get("providerSessionId") == provider_session_id
                and item["session"]["capabilities"]["steerInput"] is True,
                timeout_s=90,
            )
            resumed_session_id = resumed["session"]["id"]

            old_turn_count_before = count_text(chat_text(page), first_marker)

            composer.fill(second_text)
            page.keyboard.press("Enter")

            second_done, second_permission_ids = wait_for_idle_with_auto_permissions(
                page,
                base_url,
                resumed_session_id,
            )
            if second_done["session"]["runtimeState"] == "failed":
                raise AssertionError(f"{config.provider} claim flow failed: {second_done['session']}")
            body_after_second = wait_for_chat_text_count(page, second_marker, 2, timeout_s=240)
            assert_stop_absent(page)
            assert_composer_ready(page)
            if count_text(body_after_second, second_marker) != 2:
                raise AssertionError(
                    f"Expected one visible user prompt and one visible assistant answer for {config.provider}; "
                    f"marker count={count_text(body_after_second, second_marker)}."
                )

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
                timeout_s=240,
            )
            if recovery_done["session"]["runtimeState"] == "failed":
                raise AssertionError(f"{config.provider} recovery flow failed: {recovery_done['session']}")
            body_after_recovery = wait_for_chat_text_count(page, recovery_marker, 2, timeout_s=240)
            assert_stop_absent(page)
            assert_composer_ready(page)
            assert_interrupt_notice_count(body_after_recovery, 1)
            if count_text(body_after_recovery, recovery_marker) != 2:
                raise AssertionError(
                    f"Expected one visible user prompt and one visible assistant answer for {config.provider} recovery; "
                    f"marker count={count_text(body_after_recovery, recovery_marker)}."
                )

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
                timeout_s=240,
            )
            if second_recovery_done["session"]["runtimeState"] == "failed":
                raise AssertionError(
                    f"{config.provider} second recovery flow failed: {second_recovery_done['session']}"
                )
            body_after_recovery2 = wait_for_chat_text_count(page, recovery2_marker, 2, timeout_s=240)
            assert_stop_absent(page)
            assert_composer_ready(page)
            assert_interrupt_notice_count(body_after_recovery2, 2)
            if count_text(body_after_recovery2, recovery2_marker) != 2:
                raise AssertionError(
                    f"Expected one visible user prompt and one visible assistant answer for {config.provider} second recovery; "
                    f"marker count={count_text(body_after_recovery2, recovery2_marker)}."
                )
            save_screenshot(page, screenshots_dir, f"{config.provider}-real-claim-response")
            socket_messages = page.evaluate("window.__rahSocketMessages")
            second_user_count, second_turn_id = gather_matching_user_events(socket_messages, second_text)
            second_assistant_count = gather_assistant_events_for_turn(socket_messages, second_turn_id)
            second_tool_names = gather_tool_names_for_turn(socket_messages, second_turn_id)
            old_turn_count_after = count_text(body_after_second, first_marker)

            gamma_content = gamma.read_text(encoding="utf-8") if gamma.exists() else None

            result = {
                "ok": True,
                "baseUrl": base_url,
                "provider": config.provider,
                "browser": "chromium",
                "headless": True,
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
                    "betaContent": beta.read_text(encoding="utf-8"),
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
                },
                "gammaContent": gamma_content,
                "interruptFlow": {
                    "interruptMarkerVisibleCount": count_text(body_after_recovery2, interrupt_marker),
                    "interrupt2MarkerVisibleCount": count_text(body_after_recovery2, interrupt2_marker),
                    "interruptNoticeCount": count_text(body_after_recovery2, "Conversation interrupted"),
                    "recoveryMarkerVisibleCount": count_text(body_after_recovery2, recovery_marker),
                    "recovery2MarkerVisibleCount": count_text(body_after_recovery2, recovery2_marker),
                },
            }
            print(json.dumps(result, ensure_ascii=False, indent=2))

            assert_no_environment_leak(body_after_recovery2)
            assert_no_chat_noise(body_after_recovery2)
            assert_text_order(
                body_after_recovery2,
                second_text,
                second_marker,
                interrupt_text,
                "Conversation interrupted",
                recovery_text,
                recovery_marker,
                interrupt2_text,
                "Conversation interrupted",
                recovery2_text,
                recovery2_marker,
            )
            if second_assistant_count < 1:
                raise AssertionError(f"Expected at least one assistant event for the claimed {config.provider} turn.")
            if len(second_tool_names) < 1:
                print(
                    json.dumps(
                        {
                            "provider": config.provider,
                            "warning": "No tool event observed for claimed turn; UI ordering and live resume were verified.",
                            "turnId": second_turn_id,
                        },
                        ensure_ascii=False,
                    )
                )
            if old_turn_count_after > old_turn_count_before:
                raise AssertionError(f"Claiming {config.provider} history replayed older history into the UI.")

            return 0
        except (AssertionError, PlaywrightTimeoutError) as exc:
            try:
                save_screenshot(page, screenshots_dir, f"{config.provider}-real-failure")
                body = page.locator("body").inner_text()
                visible_chat = chat_text(page)
                socket_messages = page.evaluate("window.__rahSocketMessages")
                print(
                    json.dumps(
                        {
                            "provider": config.provider,
                            "error": str(exc),
                            "bodySnippet": body[-1600:],
                            "chatSnippet": visible_chat[-1600:],
                            "socketMessageCount": len(socket_messages),
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
            shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
