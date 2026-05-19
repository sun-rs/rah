from __future__ import annotations

import os
import pathlib
import shutil
import sys


def _trash_dir() -> pathlib.Path:
    override = os.environ.get("RAH_TRASH_DIR", "").strip()
    if override:
        return pathlib.Path(override).expanduser()
    if sys.platform == "darwin":
        return pathlib.Path.home() / ".Trash"
    if sys.platform.startswith("linux"):
        return pathlib.Path.home() / ".local" / "share" / "Trash" / "files"
    raise RuntimeError(f"Trash is not supported on {sys.platform}.")


def _unique_target(target: pathlib.Path) -> pathlib.Path:
    candidate = target
    suffix = 2
    while candidate.exists() or candidate.is_symlink():
        candidate = target.with_name(f"{target.stem} {suffix}{target.suffix}")
        suffix += 1
    return candidate


def move_path_to_trash(path_value: str | pathlib.Path, *, missing_ok: bool = True) -> pathlib.Path | None:
    source = pathlib.Path(path_value).expanduser()
    if not source.exists() and not source.is_symlink():
        if missing_ok:
            return None
        raise FileNotFoundError(source)
    trash_dir = _trash_dir()
    trash_dir.mkdir(parents=True, exist_ok=True)
    target = _unique_target(trash_dir / source.name)
    shutil.move(str(source), str(target))
    return target
