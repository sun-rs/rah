import errno
import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import sys
import termios
import time
from typing import Any, Dict, Optional


def send(message: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def resolve_shell() -> str:
    return os.environ.get("RAH_TERMINAL_SHELL") or os.environ.get("SHELL") or "/bin/zsh"


def resolve_command() -> Optional[str]:
    command = os.environ.get("RAH_TERMINAL_COMMAND")
    return command if command else None


def resolve_command_args() -> list[str]:
    raw = os.environ.get("RAH_TERMINAL_ARGS_JSON")
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [part for part in parsed if isinstance(part, str)]


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def parse_wait_status(status: int) -> Dict[str, Any]:
    if os.WIFEXITED(status):
        return {"exitCode": os.WEXITSTATUS(status)}
    if os.WIFSIGNALED(status):
        return {"signal": signal.Signals(os.WTERMSIG(status)).name}
    return {}


def main() -> int:
    shell = resolve_shell()
    cwd = os.path.abspath(os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~"))
    cols = int(sys.argv[2]) if len(sys.argv) > 2 else 100
    rows = int(sys.argv[3]) if len(sys.argv) > 3 else 32

    try:
        pid, master_fd = pty.fork()
    except Exception as error:  # pragma: no cover - startup failure path
        send({"type": "error", "message": str(error)})
        return 1

    if pid == 0:
        try:
            os.chdir(cwd)
        except Exception as error:
            print(f"failed to chdir to {cwd}: {error}", file=sys.stderr)
            os._exit(1)

        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")
        env["COLUMNS"] = str(cols)
        env["LINES"] = str(rows)
        command = resolve_command()
        if command:
            args = resolve_command_args()
            os.execvpe(command, [command, *args], env)
        os.execvpe(shell, [shell, "-i"], env)

    try:
        set_winsize(master_fd, rows, cols)
    except OSError:
        pass

    send({"type": "ready"})

    selector = selectors.DefaultSelector()
    selector.register(master_fd, selectors.EVENT_READ, "pty")
    selector.register(sys.stdin.buffer, selectors.EVENT_READ, "stdin")

    child_status: Optional[Dict[str, Any]] = None
    pty_closed = False
    close_requested_at: float | None = None

    try:
        while True:
            for key, _ in selector.select(0.1):
                if key.data == "pty":
                    try:
                        data = os.read(master_fd, 8192)
                    except OSError as error:
                        if error.errno in (errno.EIO, errno.EBADF):
                            data = b""
                        else:
                            send({"type": "error", "message": f"PTY read failed: {error}"})
                            data = b""

                    if data:
                        send(
                            {
                                "type": "output",
                                "data": data.decode("utf-8", errors="replace"),
                            },
                        )
                    else:
                        pty_closed = True
                        try:
                            selector.unregister(master_fd)
                        except Exception:
                            pass

                elif key.data == "stdin":
                    raw_line = sys.stdin.buffer.readline()
                    if not raw_line:
                        if close_requested_at is None:
                            close_requested_at = time.monotonic()
                            try:
                                os.kill(pid, signal.SIGHUP)
                            except ProcessLookupError:
                                pass
                        continue

                    try:
                        message = json.loads(raw_line.decode("utf-8"))
                    except Exception:
                        continue

                    message_type = message.get("type")
                    if message_type == "input" and isinstance(message.get("data"), str):
                        try:
                            os.write(master_fd, message["data"].encode("utf-8"))
                        except OSError as error:
                            send({"type": "error", "message": f"PTY write failed: {error}"})
                    elif (
                        message_type == "resize"
                        and isinstance(message.get("cols"), int)
                        and isinstance(message.get("rows"), int)
                    ):
                        try:
                            set_winsize(master_fd, message["rows"], message["cols"])
                            os.kill(pid, signal.SIGWINCH)
                        except OSError:
                            pass
                        except ProcessLookupError:
                            pass
                    elif message_type == "close":
                        if close_requested_at is None:
                            close_requested_at = time.monotonic()
                        try:
                            os.kill(pid, signal.SIGHUP)
                        except ProcessLookupError:
                            pass

            if child_status is None:
                try:
                    waited_pid, status = os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    waited_pid, status = pid, 0
                if waited_pid == pid:
                    child_status = parse_wait_status(status)

            if close_requested_at is not None and child_status is None:
                elapsed = time.monotonic() - close_requested_at
                if elapsed > 0.5:
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                if elapsed > 2.0:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

            if child_status is not None and pty_closed:
                send({"type": "exit", **child_status})
                break
    finally:
        try:
            selector.close()
        except Exception:
            pass
        try:
            os.close(master_fd)
        except OSError:
            pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
