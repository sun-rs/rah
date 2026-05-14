from __future__ import annotations

import json
import os
import pathlib
import shutil
import tempfile
from typing import Any
from urllib import request


def _request_json(base_url: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    if payload is None:
        req = request.Request(f"{base_url}{path}")
    else:
        req = request.Request(
            f"{base_url}{path}",
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
        )
    with request.urlopen(req, timeout=120) as response:
        body = response.read()
        return json.loads(body) if body else {}


def _session_workspace(session: dict[str, Any]) -> str:
    summary = session.get("session") if isinstance(session, dict) else None
    if not isinstance(summary, dict):
        return ""
    value = summary.get("rootDir") or summary.get("cwd")
    return value if isinstance(value, str) else ""


def _belongs_to_workspace(path_value: str, workspace: str) -> bool:
    if not path_value:
        return False
    try:
        candidate = str(pathlib.Path(path_value).expanduser().resolve())
        root = str(pathlib.Path(workspace).expanduser().resolve())
    except Exception:
        candidate = path_value.rstrip("/")
        root = workspace.rstrip("/")
    return candidate == root or candidate.startswith(root.rstrip("/") + "/")


def _resolve_path(path_value: str | pathlib.Path) -> pathlib.Path:
    return pathlib.Path(path_value).expanduser().resolve(strict=False)


def is_temp_workspace(path_value: str | pathlib.Path) -> bool:
    try:
        candidate = _resolve_path(path_value)
        temp_root = _resolve_path(tempfile.gettempdir())
    except Exception:
        return False
    return candidate != temp_root and os.path.commonpath([str(candidate), str(temp_root)]) == str(temp_root)


def _close_live_sessions_for_workspace(base_url: str, workspace: str) -> None:
    try:
        sessions = _request_json(base_url, "/api/sessions").get("sessions", [])
    except Exception:
        return
    if not isinstance(sessions, list):
        return
    for entry in sessions:
        if not isinstance(entry, dict):
            continue
        if not _belongs_to_workspace(_session_workspace(entry), workspace):
            continue
        summary = entry.get("session")
        if not isinstance(summary, dict) or not isinstance(summary.get("id"), str):
            continue
        session_id = summary["id"]
        client_id = entry.get("controlLease", {}).get("holderClientId")
        attached_clients = entry.get("attachedClients")
        if not isinstance(client_id, str) and isinstance(attached_clients, list):
            for attached in attached_clients:
                if isinstance(attached, dict) and isinstance(attached.get("id"), str):
                    client_id = attached["id"]
                    break
        if not isinstance(client_id, str):
            client_id = "rah-smoke-cleanup"
        try:
            _request_json(base_url, f"/api/sessions/{session_id}/close", {"clientId": client_id})
        except Exception:
            continue


def cleanup_smoke_workspace(
    base_url: str,
    workspace: str | pathlib.Path,
    *,
    remove_physical: bool = True,
) -> None:
    workspace_path = pathlib.Path(workspace)
    workspace_str = str(workspace_path)
    _close_live_sessions_for_workspace(base_url, workspace_str)
    try:
        _request_json(base_url, "/api/history/workspaces/remove", {"dir": workspace_str})
    except Exception:
        pass
    try:
        _request_json(base_url, "/api/workspaces/remove", {"dir": workspace_str})
    except Exception:
        pass
    if remove_physical:
        shutil.rmtree(workspace_path, ignore_errors=True)


def list_temp_workspaces_from_rah(base_url: str) -> list[str]:
    response = _request_json(base_url, "/api/sessions")
    candidates: set[str] = set()
    for key in ("workspaceDirs", "hiddenWorkspaceDirs"):
        value = response.get(key)
        if isinstance(value, list):
            candidates.update(item for item in value if isinstance(item, str))
    active = response.get("activeWorkspaceDir")
    if isinstance(active, str):
        candidates.add(active)
    for collection_key in ("sessions", "storedSessions", "recentSessions"):
        collection = response.get(collection_key)
        if not isinstance(collection, list):
            continue
        for item in collection:
            if not isinstance(item, dict):
                continue
            session = item.get("session") if collection_key == "sessions" else item
            if not isinstance(session, dict):
                continue
            for path_key in ("rootDir", "cwd"):
                path_value = session.get(path_key)
                if isinstance(path_value, str):
                    candidates.add(path_value)
    canonical: set[str] = set()
    for path in candidates:
        if is_temp_workspace(path):
            canonical.add(str(_resolve_path(path)))
    return sorted(canonical)
