from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import rah_smoke_cleanup


class RahSmokeCleanupTest(unittest.TestCase):
    def test_temp_workspace_detection_is_limited_to_rah_prefixes(self) -> None:
        temp_root = pathlib.Path(tempfile.gettempdir()).resolve(strict=False)

        self.assertTrue(rah_smoke_cleanup.is_temp_workspace(temp_root / "rah-terminal-browser-demo"))
        self.assertTrue(rah_smoke_cleanup.is_temp_workspace(temp_root / "rah-test" / "workspace"))
        self.assertFalse(rah_smoke_cleanup.is_temp_workspace(temp_root / "ordinary-project"))
        self.assertFalse(rah_smoke_cleanup.is_temp_workspace("/Users/sun/Code/repos/rah"))

    def test_cleanup_closes_owned_independent_terminals_before_removing_workspace(self) -> None:
        workspace = pathlib.Path(tempfile.gettempdir()) / "rah-cleanup-owned-terminal" / "workspace"
        calls: list[tuple[str, dict[str, object] | None]] = []

        def fake_request_json(base_url: str, path: str, payload: dict[str, object] | None = None) -> dict[str, object]:
            calls.append((path, payload))
            if path == "/api/sessions":
                return {"sessions": []}
            if path == "/api/terminal/list":
                return {
                    "terminals": [
                        {
                            "id": "terminal-owned",
                            "cwd": str(workspace),
                            "owner": {"kind": "workspace", "id": str(workspace)},
                        },
                        {
                            "id": "terminal-other",
                            "cwd": "/Users/sun/Code/repos/rah",
                            "owner": {"kind": "workspace", "id": "/Users/sun/Code/repos/rah"},
                        },
                    ]
                }
            return {"ok": True}

        with mock.patch.object(rah_smoke_cleanup, "_request_json", side_effect=fake_request_json):
            with mock.patch.object(rah_smoke_cleanup.shutil, "rmtree") as rmtree:
                rah_smoke_cleanup.cleanup_smoke_workspace("http://127.0.0.1:43111", workspace)

        paths = [path for path, _payload in calls]
        self.assertIn("/api/terminal/terminal-owned/close", paths)
        self.assertNotIn("/api/terminal/terminal-other/close", paths)
        self.assertLess(paths.index("/api/terminal/terminal-owned/close"), paths.index("/api/workspaces/remove"))
        rmtree.assert_called_once_with(workspace, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
