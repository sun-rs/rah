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


def assert_no_environment_leak(body: str) -> None:
    if "<environment_context>" in body:
        raise AssertionError("Environment context leaked into the chat UI.")


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
    first_text = first_prompt(config, first_marker)
    second_text = second_prompt(config, second_marker)

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
            body_after_replay = wait_for_body_contains(page, first_marker, timeout_s=90)
            if count_text(body_after_replay, first_marker) < 1:
                raise AssertionError(f"{config.provider} history replay did not show the first turn marker.")

            page.get_by_role("button", name="Claim control").click()
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

            old_turn_count_before = count_text(page.locator("body").inner_text(), first_marker)

            composer.fill(second_text)
            page.keyboard.press("Enter")

            second_done, second_permission_ids = wait_for_idle_with_auto_permissions(
                page,
                base_url,
                resumed_session_id,
            )
            if second_done["session"]["runtimeState"] == "failed":
                raise AssertionError(f"{config.provider} claim flow failed: {second_done['session']}")
            body_after_second = page.locator("body").inner_text()
            socket_messages = page.evaluate("window.__rahSocketMessages")
            second_user_count, second_turn_id = gather_matching_user_events(socket_messages, second_text)
            second_assistant_count = gather_assistant_events_for_turn(socket_messages, second_turn_id)
            second_tool_names = gather_tool_names_for_turn(socket_messages, second_turn_id)
            old_turn_count_after = count_text(body_after_second, first_marker)

            if gamma.read_text(encoding="utf-8") != config.gamma_text:
                raise AssertionError(f"{config.provider} claim flow did not create gamma.txt correctly.")

            result = {
                "baseUrl": base_url,
                "provider": config.provider,
                "providerSessionId": provider_session_id,
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
                "gammaContent": gamma.read_text(encoding="utf-8"),
            }
            print(json.dumps(result, ensure_ascii=False, indent=2))

            assert_no_environment_leak(body_after_second)
            if second_user_count != 1:
                raise AssertionError(f"Expected exactly one user event for the claimed {config.provider} turn.")
            if second_assistant_count < 1:
                raise AssertionError(f"Expected at least one assistant event for the claimed {config.provider} turn.")
            if len(second_tool_names) < 1:
                raise AssertionError(f"Expected at least one tool event for the claimed {config.provider} turn.")
            if old_turn_count_after > old_turn_count_before:
                raise AssertionError(f"Claiming {config.provider} history replayed older history into the UI.")

            return 0
        except (AssertionError, PlaywrightTimeoutError) as exc:
            try:
                body = page.locator("body").inner_text()
                socket_messages = page.evaluate("window.__rahSocketMessages")
                print(
                    json.dumps(
                        {
                            "provider": config.provider,
                            "error": str(exc),
                            "bodySnippet": body[-1600:],
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
