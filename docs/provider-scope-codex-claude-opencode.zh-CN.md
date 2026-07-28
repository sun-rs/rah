# Provider Scope: Codex + Claude + OpenCode

复核日期：2026-07-28

RAH 当前 live 主线：

- Codex：OpenAI/GPT 原生 TUI 和订阅账号能力。
- Claude Code：Anthropic/Claude 原生 TUI 和订阅账号能力。
- OpenCode：API-key 聚合入口，承接 Kimi、Grok、DeepSeek、GLM、MiniMax 等低频或中转模型。

独立低频 CLI provider 不再作为 live、history-only、diagnostics 或默认 QA 对象保留；对应模型统一通过 OpenCode/API provider 使用。

## 移除原因

RAH 的核心产品价值是 daemon 持有真实 provider session，实现 Web、PWA、iPad/iPhone 之间的无缝接续。这个核心必须稳定，不能被每家 CLI 的快速变更拖成长期适配黑洞。

Kimi CLI 对当前 RAH 的投入产出不成立：

- 使用频率低于 Codex / Claude。
- 模型可以通过 OpenCode + API-key / AIHubMix / OpenRouter 等中转按量使用。
- 保留一等 CLI 支持会额外维护启动参数、resume 规则、历史文件解析、rename/delete、权限、plan、模型参数、diagnostics、smoke、人类 QA。
- 同时追踪过多 CLI 的官方版本变化，会显著增加重复输出、状态竞态、权限语义漂移和移动端真实测试负担。

因此 RAH 不再追求“每家 CLI 都完整 Web 化”。长期维护面收敛为：Codex 和 Claude 负责主力原生订阅体验，OpenCode 负责 API-key 多模型入口。

## Codex Desktop 产品表面边界

Codex Desktop 的 Codex Task、普通 ChatGPT Work 对话和内部 subagent rollout 可能共用
`~/.codex/sessions` 物理目录。RAH 的 Codex provider scope 只包含用户可见的 Codex Task：

- `session_meta.payload.originator=codex_work_desktop` 的记录属于普通 ChatGPT Work 对话；
- `session_meta.payload.source` 或 `thread_source` 明确包含 `subagent` 的记录属于父任务内部执行；
- 两者都不进入 RAH Sidebar、Chats、Recent、All 或 Archived；
- RAH 只做 catalog 过滤，不移动、修改或删除这些 provider-owned 文件。

文件路径、标题索引和历史 RAH cache 不是产品表面权威。可见 Session 必须由当前 provider catalog
确认，并按 `{provider, providerSessionId}` 投影成唯一 row。

## OpenCode 模型与 Variant 边界

OpenCode 的 Web 主链路使用本地 server/session API。RAH 通过结构化请求传递 `provider/model/variant`，并用 provider session 的实际状态更新界面。

TUI 是同一 session 的辅助视图，不是新建或 resume 的第二条用户入口。RAH 不通过猜测 TUI 启动参数来宣称 variant 生效；variant 的正确性由 server API 请求与回归测试保证。

## OpenCode 权限边界

OpenCode 的默认配置并不是所有权限都无条件放行。它默认允许大多数工具，但 `external_directory` 默认是 `ask`，用于保护工作区之外的路径。因此 RAH 中的 OpenCode 在读取或操作非当前工作区路径时可能仍会请求 approval。

如果使用者希望 OpenCode 对工作区外路径不再反复确认，应在用户级 OpenCode 配置中显式允许：

```json
{
  "permission": {
    "external_directory": {
      "*": "allow"
    }
  }
}
```

这个配置比把全局 `permission` 设成 `"allow"` 更窄，只放开外部目录 guard，不改变其它工具的既有规则。OpenCode 同时支持 `OPENCODE_PERMISSION='{"external_directory":{"*":"allow"}}'` 作为单次启动注入；RAH 若未来需要做 session-scoped 权限增强，应优先使用这个环境变量而不是改写用户全局配置。
