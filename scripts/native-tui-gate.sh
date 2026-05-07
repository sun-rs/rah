#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

run npm run typecheck
run npm run test:web
run npm run test:runtime
run npm run build:web
run env RAH_NATIVE_CLI_PROBE_OUTPUT="${RAH_NATIVE_CLI_PROBE_OUTPUT:-test-results/native-cli-probe.json}" npm run test:smoke:native-cli-probe
run npm run test:smoke:native-codex
run npm run test:smoke:native-providers
run npm run test:smoke:native-codex-browser
run npm run test:smoke:native-provider-browser
run git diff --check
