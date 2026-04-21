Provider logo assets in this directory are sourced from the local `AionUi` project.

Copied now:
- `brand/aion.svg`
- `brand/auggie.svg`
- `brand/droid.svg`
- `brand/hermes.svg`
- `ai-major/claude.svg`
- `ai-major/gemini.svg`
- `ai-major/mistral.svg`
- `ai-china/kimi.svg`
- `ai-china/qwen.svg`
- `tools/github.svg`
- `tools/goose.svg`
- `tools/iflow.svg`
- `tools/nanobot.svg`
- `tools/openclaw.svg`
- `tools/coding/codebuddy.svg`
- `tools/coding/codex.svg`
- `tools/coding/cursor.png`
- `tools/coding/opencode.svg`
- `tools/coding/opencode-light.svg`
- `tools/coding/opencode-dark.svg`
- `tools/coding/qoder.png`

The upstream file declaring the mapping is:
- `AionUi/src/renderer/utils/model/agentLogo.ts`

In RAH we split these into two buckets:
- `implementedProviderLogoRegistry`: providers already exposed in the product UI
- `reservedProviderLogoRegistry`: assets preloaded for future adapters or experiments

Upstream license note:
- `Copyright 2025 AionUi (aionui.com)`
- `SPDX-License-Identifier: Apache-2.0`
