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
            with mock.patch.object(rah_smoke_cleanup, "move_path_to_trash") as move_path_to_trash:
                rah_smoke_cleanup.cleanup_smoke_workspace("http://127.0.0.1:43111", workspace)

        paths = [path for path, _payload in calls]
        self.assertIn("/api/terminal/terminal-owned/close", paths)
        self.assertNotIn("/api/terminal/terminal-other/close", paths)
        self.assertLess(paths.index("/api/terminal/terminal-owned/close"), paths.index("/api/workspaces/remove"))
        move_path_to_trash.assert_called_once_with(workspace)

    def test_cleanup_refuses_to_remove_non_temp_workspace(self) -> None:
        workspace = pathlib.Path("/Users/sun/Code/repos/rah")

        def fake_request_json(base_url: str, path: str, payload: dict[str, object] | None = None) -> dict[str, object]:
            if path == "/api/sessions":
                return {"sessions": []}
            if path == "/api/terminal/list":
                return {"terminals": []}
            return {"ok": True}

        with mock.patch.object(rah_smoke_cleanup, "_request_json", side_effect=fake_request_json):
            with mock.patch.object(rah_smoke_cleanup, "move_path_to_trash") as move_path_to_trash:
                with self.assertRaisesRegex(RuntimeError, "Refusing to remove non-temp"):
                    rah_smoke_cleanup.cleanup_smoke_workspace("http://127.0.0.1:43111", workspace)
        move_path_to_trash.assert_not_called()

    def test_smoke_scripts_do_not_directly_delete_cleanup_paths(self) -> None:
        scripts_dir = pathlib.Path(__file__).resolve().parent
        excluded = {"rah_smoke_cleanup_test.py", "safe_trash.py", "safe-trash.ts"}
        forbidden = (
            "shutil.rmtree(",
            "rmSync(",
            "fs.rmSync(",
            "unlinkSync(",
            "rm -rf",
            "rm -fr",
        )
        offenders: list[str] = []
        for path in scripts_dir.iterdir():
            if path.name in excluded or path.suffix not in {".py", ".ts", ".mjs", ".sh"}:
                continue
            text = path.read_text(encoding="utf-8")
            for pattern in forbidden:
                if pattern in text:
                    offenders.append(f"{path.name}: {pattern}")
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
