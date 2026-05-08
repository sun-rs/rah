#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

run npm run typecheck
run node --import tsx --test --test-concurrency=1 --test-force-exit \
  packages/runtime-daemon/src/zellij-mux-backend.test.ts \
  packages/runtime-daemon/src/zellij-tui-runtime.test.ts
run npm run test:zellij-manual-qa-status
run npm run test:smoke:zellij-real-tui-launch
run npm run test:smoke:zellij-real-tui-exit
run git diff --check
