#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

run_exit_probe() {
  local provider="$1"
  local settle_ms="$2"
  local exit_input="$3"

  printf '\n==> zellij real TUI exit probe: %s\n' "$provider"
  RAH_ZELLIJ_REAL_TUI_PROBE_PROVIDERS="$provider" \
    RAH_ZELLIJ_REAL_TUI_PROBE_SETTLE_MS="$settle_ms" \
    RAH_ZELLIJ_REAL_TUI_PROBE_EXIT=1 \
    RAH_ZELLIJ_REAL_TUI_PROBE_EXIT_INPUT="$exit_input" \
    tsx scripts/zellij_real_tui_launch_probe.ts
}

run_exit_probe codex 6000 $'\004'
run_exit_probe claude 3000 $'\033'
run_exit_probe opencode 6000 $'\004'
