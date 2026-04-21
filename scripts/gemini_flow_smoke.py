from __future__ import annotations

import json
import os
import pathlib
import shutil
import tempfile
import time
from typing import Any
from urllib import request


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


def wait_for_idle(base_url: str, session_id: str, timeout_s: int = 240) -> dict[str, Any]:
    started = time.time()
    last: dict[str, Any] | None = None
    while time.time() - started < timeout_s:
        last = request_json(base_url, f"/api/sessions/{session_id}")["session"]
        runtime_state = last["session"]["runtimeState"]
        if runtime_state in ("idle", "failed", "stopped"):
            return last
        time.sleep(1)
    raise TimeoutError(f"Timed out waiting for {session_id}; last={last}")


def close_session(base_url: str, session_id: str, client_id: str) -> None:
    try:
        request_json(base_url, f"/api/sessions/{session_id}/close", {"clientId": client_id})
    except Exception:
        pass


def main() -> int:
    base_url = os.environ.get("RAH_BASE_URL", "http://127.0.0.1:43111")
    client_id = f"gemini-flow-smoke-{int(time.time())}"
    cwd = pathlib.Path(tempfile.mkdtemp(prefix="rah-gemini-flow-"))
    alpha = cwd / "alpha.txt"
    beta = cwd / "beta.txt"
    gamma = cwd / "gamma.txt"
    alpha.write_text("ALPHA-CONTENT\n", encoding="utf-8")

    live_session_id: str | None = None
    replay_session_id: str | None = None
    resumed_session_id: str | None = None

    try:
        started = request_json(
            base_url,
            "/api/sessions/start",
            {
                "provider": "gemini",
                "cwd": str(cwd),
                "attach": {
                    "client": {"id": client_id, "kind": "web", "connectionId": client_id},
                    "mode": "interactive",
                    "claimControl": True,
                },
            },
        )["session"]
        live_session_id = started["session"]["id"]

        first_prompt = (
            "Read alpha.txt. Then create beta.txt containing exactly BETA-OK on one line. "
            "Finally answer with exactly DONE-1."
        )
        request_json(
            base_url,
            f"/api/sessions/{live_session_id}/input",
            {"clientId": client_id, "text": first_prompt},
        )
        first_done = wait_for_idle(base_url, live_session_id)
        provider_session_id = first_done["session"].get("providerSessionId")
        if not isinstance(provider_session_id, str) or not provider_session_id:
            raise AssertionError("Gemini session never published a providerSessionId.")

        if not beta.exists() or beta.read_text(encoding="utf-8") != "BETA-OK\n":
            raise AssertionError("Gemini did not create beta.txt with the expected content.")

        close_session(base_url, live_session_id, client_id)

        sessions = request_json(base_url, "/api/sessions")
        recent = [
            item
            for item in sessions.get("recentSessions", [])
            if item.get("provider") == "gemini"
            and item.get("providerSessionId") == provider_session_id
        ]
        stored = [
            item
            for item in sessions.get("storedSessions", [])
            if item.get("provider") == "gemini"
            and item.get("providerSessionId") == provider_session_id
        ]
        if not recent:
            raise AssertionError("Closed Gemini session did not appear in recentSessions.")
        if not stored:
            raise AssertionError("Closed Gemini session did not appear in storedSessions.")

        replay = request_json(
            base_url,
            "/api/sessions/resume",
            {
                "provider": "gemini",
                "providerSessionId": provider_session_id,
                "cwd": str(cwd),
                "preferStoredReplay": True,
                "attach": {
                    "client": {"id": client_id, "kind": "web", "connectionId": client_id},
                    "mode": "observe",
                },
            },
        )["session"]
        replay_session_id = replay["session"]["id"]
        if replay["session"]["capabilities"]["steerInput"] is not False:
            raise AssertionError("Gemini replay session should be read-only.")

        history = request_json(base_url, f"/api/sessions/{replay_session_id}/history?limit=1000")
        assistant_texts = [
            event["payload"]["item"]["text"]
            for event in history.get("events", [])
            if event.get("type") == "timeline.item.added"
            and event.get("payload", {}).get("item", {}).get("kind") == "assistant_message"
        ]
        tool_names = [
            event["payload"]["toolCall"]["providerToolName"]
            for event in history.get("events", [])
            if event.get("type") == "tool.call.completed"
        ]
        if "read_file" not in tool_names or "write_file" not in tool_names:
            raise AssertionError("Gemini replay history did not include expected file tool calls.")
        if "DONE-1" not in assistant_texts:
            raise AssertionError("Gemini replay history did not include the final assistant answer.")

        close_session(base_url, replay_session_id, client_id)
        replay_session_id = None

        resumed = request_json(
            base_url,
            "/api/sessions/resume",
            {
                "provider": "gemini",
                "providerSessionId": provider_session_id,
                "cwd": str(cwd),
                "preferStoredReplay": False,
                "historyReplay": "skip",
                "attach": {
                    "client": {"id": client_id, "kind": "web", "connectionId": client_id},
                    "mode": "interactive",
                    "claimControl": True,
                },
            },
        )["session"]
        resumed_session_id = resumed["session"]["id"]
        if resumed["session"]["capabilities"]["steerInput"] is not True:
            raise AssertionError("Gemini resumed live session should be interactive.")

        second_prompt = (
            "Read beta.txt. Then create gamma.txt containing exactly GAMMA-OK on one line. "
            "Finally answer with exactly DONE-2."
        )
        request_json(
            base_url,
            f"/api/sessions/{resumed_session_id}/input",
            {"clientId": client_id, "text": second_prompt},
        )
        second_done = wait_for_idle(base_url, resumed_session_id)
        if second_done["session"].get("providerSessionId") != provider_session_id:
            raise AssertionError("Gemini live resume changed the providerSessionId unexpectedly.")

        if not gamma.exists() or gamma.read_text(encoding="utf-8") != "GAMMA-OK\n":
            raise AssertionError("Gemini live resume did not create gamma.txt with the expected content.")

        result = {
            "baseUrl": base_url,
            "cwd": str(cwd),
            "providerSessionId": provider_session_id,
            "recentCount": len(recent),
            "storedCount": len(stored),
            "historyToolNames": tool_names,
            "historyAssistantTexts": assistant_texts,
            "betaContent": beta.read_text(encoding="utf-8"),
            "gammaContent": gamma.read_text(encoding="utf-8"),
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    finally:
        if resumed_session_id:
            close_session(base_url, resumed_session_id, client_id)
        if replay_session_id:
            close_session(base_url, replay_session_id, client_id)
        if live_session_id:
            close_session(base_url, live_session_id, client_id)
        shutil.rmtree(cwd, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
