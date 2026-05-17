import base64
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
from typing import Any, Dict, Iterator, Optional, Tuple


HOST_FRAME_READY = 1
HOST_FRAME_OUTPUT = 2
HOST_FRAME_ERROR = 3
HOST_FRAME_EXIT = 4

CLIENT_FRAME_INPUT = 1
CLIENT_FRAME_RESIZE = 2
CLIENT_FRAME_CLOSE = 3

FRAME_HEADER_SIZE = 5
MAX_CLIENT_FRAME_BYTES = 16 * 1024 * 1024


def send_frame(frame_type: int, payload: bytes = b"") -> None:
    sys.stdout.buffer.write(bytes([frame_type]) + struct.pack(">I", len(payload)) + payload)
    sys.stdout.buffer.flush()


def send_legacy(message: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def send_json_frame(frame_type: int, payload: Dict[str, Any]) -> None:
    send_frame(frame_type, json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def read_client_frames(buffer: bytearray) -> Iterator[Tuple[int, bytes]]:
    while len(buffer) >= FRAME_HEADER_SIZE:
        frame_type = buffer[0]
        payload_length = struct.unpack(">I", buffer[1:FRAME_HEADER_SIZE])[0]
        if payload_length > MAX_CLIENT_FRAME_BYTES:
            raise ValueError(f"client frame is too large: {payload_length} bytes")
        frame_length = FRAME_HEADER_SIZE + payload_length
        if len(buffer) < frame_length:
            return
        payload = bytes(buffer[FRAME_HEADER_SIZE:frame_length])
        del buffer[:frame_length]
        yield frame_type, payload


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


def use_binary_protocol() -> bool:
    return os.environ.get("RAH_TERMINAL_HOST_PROTOCOL") == "2"


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def set_nonblocking(fd: int) -> None:
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


def normalize_terminal_env(env: Dict[str, str], rows: int, cols: int) -> Dict[str, str]:
    for key in (
        "ALACRITTY_SOCKET",
        "GNOME_TERMINAL_SCREEN",
        "ITERM_PROFILE",
        "ITERM_PROFILE_NAME",
        "ITERM_SESSION_ID",
        "KITTY_WINDOW_ID",
        "KONSOLE_VERSION",
        "NO_COLOR",
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "TERM_SESSION_ID",
        "TMUX",
        "VTE_VERSION",
        "WEZTERM_VERSION",
        "WT_SESSION",
    ):
        env.pop(key, None)
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env["CLICOLOR"] = "1"
    env["FORCE_COLOR"] = "1"
    env["COLUMNS"] = str(cols)
    env["LINES"] = str(rows)
    return env


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
    binary_protocol = use_binary_protocol()

    try:
        pid, master_fd = pty.fork()
    except Exception as error:  # pragma: no cover - startup failure path
        if binary_protocol:
            send_json_frame(HOST_FRAME_ERROR, {"message": str(error)})
        else:
            send_legacy({"type": "error", "message": str(error)})
        return 1

    if pid == 0:
        try:
            os.chdir(cwd)
        except Exception as error:
            print(f"failed to chdir to {cwd}: {error}", file=sys.stderr)
            os._exit(1)

        env = normalize_terminal_env(os.environ.copy(), rows, cols)
        command = resolve_command()
        if command:
            args = resolve_command_args()
            os.execvpe(command, [command, *args], env)
        os.execvpe(shell, [shell, "-i"], env)

    try:
        set_winsize(master_fd, rows, cols)
    except OSError:
        pass

    if binary_protocol:
        send_frame(HOST_FRAME_READY)
    else:
        send_legacy({"type": "ready"})

    selector = selectors.DefaultSelector()
    selector.register(master_fd, selectors.EVENT_READ, "pty")
    stdin_fd = sys.stdin.buffer.fileno()
    set_nonblocking(stdin_fd)
    selector.register(stdin_fd, selectors.EVENT_READ, "stdin")

    child_status: Optional[Dict[str, Any]] = None
    pty_closed = False
    close_requested_at: float | None = None
    stdin_buffer = bytearray()
    legacy_stdin_buffer = bytearray()

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
                            if binary_protocol:
                                send_json_frame(HOST_FRAME_ERROR, {"message": f"PTY read failed: {error}"})
                            else:
                                send_legacy({"type": "error", "message": f"PTY read failed: {error}"})
                            data = b""

                    if data:
                        if binary_protocol:
                            send_frame(HOST_FRAME_OUTPUT, data)
                        else:
                            send_legacy(
                                {
                                    "type": "output",
                                    "dataBase64": base64.b64encode(data).decode("ascii"),
                                },
                            )
                    else:
                        pty_closed = True
                        try:
                            selector.unregister(master_fd)
                        except Exception:
                            pass

                elif key.data == "stdin":
                    if not binary_protocol:
                        while True:
                            try:
                                raw = os.read(stdin_fd, 65536)
                            except BlockingIOError:
                                break
                            except OSError:
                                raw = b""
                            if not raw:
                                if close_requested_at is None:
                                    close_requested_at = time.monotonic()
                                    try:
                                        os.kill(pid, signal.SIGHUP)
                                    except ProcessLookupError:
                                        pass
                                break
                            legacy_stdin_buffer.extend(raw)
                            if len(legacy_stdin_buffer) > MAX_CLIENT_FRAME_BYTES:
                                del legacy_stdin_buffer[: len(legacy_stdin_buffer) - MAX_CLIENT_FRAME_BYTES]

                            while b"\n" in legacy_stdin_buffer:
                                line_end = legacy_stdin_buffer.index(b"\n")
                                raw_line = bytes(legacy_stdin_buffer[:line_end])
                                del legacy_stdin_buffer[: line_end + 1]
                                if not raw_line:
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
                                        send_legacy({"type": "error", "message": f"PTY write failed: {error}"})
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
                        continue

                    while True:
                        try:
                            raw = os.read(stdin_fd, 65536)
                        except BlockingIOError:
                            break
                        except OSError:
                            raw = b""
                        if not raw:
                            if close_requested_at is None:
                                close_requested_at = time.monotonic()
                                try:
                                    os.kill(pid, signal.SIGHUP)
                                except ProcessLookupError:
                                    pass
                            break

                        try:
                            stdin_buffer.extend(raw)
                            for frame_type, payload in read_client_frames(stdin_buffer):
                                if frame_type == CLIENT_FRAME_INPUT:
                                    try:
                                        os.write(master_fd, payload)
                                    except OSError as error:
                                        send_json_frame(HOST_FRAME_ERROR, {"message": f"PTY write failed: {error}"})
                                elif frame_type == CLIENT_FRAME_RESIZE:
                                    try:
                                        message = json.loads(payload.decode("utf-8"))
                                    except Exception:
                                        continue
                                    cols = message.get("cols")
                                    rows = message.get("rows")
                                    if not isinstance(cols, int) or not isinstance(rows, int):
                                        continue
                                    try:
                                        set_winsize(master_fd, rows, cols)
                                        os.kill(pid, signal.SIGWINCH)
                                    except OSError:
                                        pass
                                    except ProcessLookupError:
                                        pass
                                elif frame_type == CLIENT_FRAME_CLOSE:
                                    if close_requested_at is None:
                                        close_requested_at = time.monotonic()
                                    try:
                                        os.kill(pid, signal.SIGHUP)
                                    except ProcessLookupError:
                                        pass
                        except ValueError as error:
                            send_json_frame(HOST_FRAME_ERROR, {"message": str(error)})
                            stdin_buffer.clear()

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
                if binary_protocol:
                    send_json_frame(HOST_FRAME_EXIT, child_status)
                else:
                    send_legacy({"type": "exit", **child_status})
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
