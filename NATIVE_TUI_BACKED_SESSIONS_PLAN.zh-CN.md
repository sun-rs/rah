# Native TUI Backed Sessions Historical Plan

状态更新：2026-05-08

本文原本记录 `refactor/native-tui-backed-sessions` 阶段的旧设计。当前主线已经迁移到
`refactor/pty-first-core`，以根目录
[`RAH_PTY_FIRST_SEAMLESS_WORKBENCH_PLAN.zh-CN.md`](./RAH_PTY_FIRST_SEAMLESS_WORKBENCH_PLAN.zh-CN.md)
和 [`desgin.md`](./desgin.md) 为准。

旧分支的核心判断仍被保留：

- 官方 TUI 是 live truth source。
- Chat timeline 是 provider history/jsonl/db mirror，不是唯一真相。
- Adapter 的主责从“复刻 provider live protocol”降为 launch + observe + mirror + minimal control。
- Mirror 失败只影响结构化展示，不能影响 TUI live session。
- Provider 新增 `/goal`、权限菜单、模型菜单等能力时，RAH 不需要立即适配，用户可直接切到 TUI 使用。

当前分支的关键变化：

- Core live provider 只保留 Codex、Claude、OpenCode。
- Gemini/Kimi CLI 一等支持已删除，不再保留 live、history-only、diagnostics 或默认 QA 代码。
- 低频 Gemini/Kimi/Grok/DeepSeek/GLM/MiniMax 等模型通过 OpenCode + API provider / 中转站承载。
- public `rah <provider>`、Web New、Canvas New、Web Claim History 都进入 daemon-owned PTY-first native TUI runtime。
- old structured live 和 wrapper-control 只保留为内部 legacy/test harness，不是公开 live 主路径。

为什么不保留旧全文：

旧文档包含大量 Gemini/Kimi native live、archived history、五家 provider smoke、旧 wrapper handoff 等阶段性设计。这些内容已经不再代表当前系统，继续保留在交付入口会误导后续开发和 QA。需要追溯旧阶段细节时应通过 git history 查看本文件的历史版本。
