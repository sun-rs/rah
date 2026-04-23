#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
node --import tsx scripts/claude_flow_smoke.ts
