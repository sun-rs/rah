#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
bun scripts/claude_flow_smoke.ts
