from __future__ import annotations

import os
import signal
import subprocess


def _child_pids(pid: int) -> list[int]:
    try:
        output = subprocess.check_output(
            ["pgrep", "-P", str(pid)],
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    return [int(line) for line in output.splitlines() if line.strip().isdigit()]


def descendant_pids(pid: int) -> list[int]:
    descendants: list[int] = []
    stack = [pid]
    while stack:
        parent = stack.pop()
        children = _child_pids(parent)
        descendants.extend(children)
        stack.extend(children)
    return descendants


def _signal_pids(pids: list[int], sig: int) -> None:
    for pid in reversed(pids):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            pass


def terminate_process_tree(proc: subprocess.Popen[str], timeout_s: float = 3.0) -> None:
    if proc.poll() is not None:
        return
    _signal_pids(descendant_pids(proc.pid), signal.SIGTERM)
    proc.terminate()
    try:
        proc.wait(timeout=timeout_s)
        return
    except subprocess.TimeoutExpired:
        pass
    _signal_pids(descendant_pids(proc.pid), signal.SIGKILL)
    proc.kill()
    try:
        proc.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        pass
