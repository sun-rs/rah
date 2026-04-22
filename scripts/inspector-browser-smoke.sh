#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

choose_python() {
  if python3 - <<'PY' >/dev/null 2>&1
import playwright  # noqa: F401
PY
  then
    printf '%s\n' python3
    return
  fi

  if [ -x /opt/homebrew/opt/python@3.13/bin/python3.13 ] && /opt/homebrew/opt/python@3.13/bin/python3.13 - <<'PY' >/dev/null 2>&1
import playwright  # noqa: F401
PY
  then
    printf '%s\n' /opt/homebrew/opt/python@3.13/bin/python3.13
    return
  fi

  echo "Python Playwright runtime not found. Install Playwright for python or adjust scripts/inspector-browser-smoke.sh." >&2
  exit 1
}

PYTHON_BIN="$(choose_python)"
exec "$PYTHON_BIN" "$ROOT_DIR/scripts/inspector_browser_smoke.py"
