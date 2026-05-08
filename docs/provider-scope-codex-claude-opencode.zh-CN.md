# Provider Scope: Codex + Claude + OpenCode

日期：2026-05-08

RAH 当前 live 主线只保留三家：

- Codex：OpenAI/GPT 原生 TUI 和订阅账号能力。
- Claude Code：Anthropic/Claude 原生 TUI 和订阅账号能力。
- OpenCode：API-key 聚合入口，承接 Gemini、Kimi、Grok、DeepSeek、GLM、MiniMax 等低频或中转模型。

Gemini CLI 和 Kimi CLI 的一等 provider 代码已移除，不再作为 live、history-only、diagnostics 或默认 QA 对象保留。

## 移除原因

RAH 的核心产品价值是 daemon 持有真实 PTY/TUI session，实现桌面 Terminal、Web、PWA、iPad/iPhone 之间的无缝接续。这个核心必须稳定，不能被五家 CLI 的快速变更拖成长期适配黑洞。

Gemini CLI 与 Kimi CLI 对当前 RAH 的投入产出不成立：

- 使用频率低于 Codex / Claude。
- 模型可以通过 OpenCode + API-key / AIHubMix / OpenRouter 等中转按量使用。
- 保留一等 CLI 支持会额外维护启动参数、resume 规则、历史文件解析、rename/delete、权限、plan、模型参数、diagnostics、smoke、人类 QA。
- 五家 CLI 同时追官方版本变化，会显著增加重复输出、状态竞态、权限语义漂移和移动端真实测试负担。

因此 RAH 不再追求“五家 CLI 都完整 Web 化”。长期维护面收敛为：Codex 和 Claude 负责最强原生订阅体验，OpenCode 负责 API-key 多模型入口。

## OpenCode 模型与 Variant 边界

OpenCode native TUI 当前稳定公开的启动参数是：

```text
opencode --model provider/model <project>
```

所以 RAH 的 PTY-first native TUI 启动只保证基础 `provider/model` 会进入 OpenCode TUI。

OpenCode 的 reasoning/variant 能力仍属于 OpenCode 自己的 provider-specific enhancement：

- `opencode run --variant` 是 OpenCode run 路径能力。
- ACP / structured OpenCode 路径可以传 `provider/model/variant`，RAH 对该路径保留测试断言。
- PTY-first native TUI 不把 `variant` 拼进 `--model`，也不把未公开的 `--variant` 当作稳定启动参数。

这条边界避免 RAH 伪装支持 OpenCode TUI 尚未稳定公开的能力。需要严格 variant 的任务，应走 OpenCode 原生支持的路径或在 TUI 内自行选择。
