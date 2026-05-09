# Native Local Server 重构 Goal 正文

详细计划见：

`/Users/sun/Code/repos/rah/RAH_NATIVE_LOCAL_SERVER_REFACTOR_PLAN.zh-CN.md`

可直接用于 `/goal` 的正文：

```text
目标：在当前分支 refactor/native-local-server-core 上完成 RAH provider runtime 重构。详细计划见 /Users/sun/Code/repos/rah/RAH_NATIVE_LOCAL_SERVER_REFACTOR_PLAN.zh-CN.md。

核心原则：实用主义、稳健性、MVP、DRY。不要重写无关功能，不要把三家 provider 强行抽象成同一种底层。RAH 的核心定位是无缝衔接工作台，不是普通 chatbox。

架构目标：
1. Codex 改为 native_local_server 主链路，以官方 app-server 的结构化事件流作为 live source of truth。Web chat 直接走官方 turn/send/interrupt/event 协议；RAH 先通过 `thread/start` 预创建 thread 并拿到 `threadId`，再让本地 TUI 通过 `codex --remote <ws-endpoint> resume <threadId>` 作为官方 client/view 接入同一 thread，禁止依赖 rollout/首条消息反推绑定。Codex 0.130.0 remote TUI/cross-client sync 与 real turn interrupt 已由 `scripts/native_local_server_probe.ts` 验证；archive lifecycle 仍需继续 smoke/人工验收。
2. OpenCode 改为 native_local_server 主链路，以官方 serve/attach/session API 的结构化事件流作为 live source of truth。Web chat 直接走 OpenCode API，本地 TUI 通过官方 attach/client 接入同一 session；attach 必须绑定精确 provider session，例如 `opencode attach <url> --session <providerSessionId>`，不能只连 server URL；仍必须用真实双端同步测试证明。
3. Claude 保留 zellij/tui_mux_fallback 作为默认连续性路径。不要假装 Claude 有 Codex/OpenCode 等价的本地 app-server；不要把 SDK/headless/stream-json 当成原生 TUI 无缝接续的替代品。Claude 的结构化 chat 继续来自 JSONL/parser/watcher，zellij 负责 TUI 工作现场接管与归还。
4. zellij 不是临时废弃物，而是长期万能 fallback：未来任何没有 native local server 但有可用 TUI 的 CLI，都应能先通过 tui_mux_fallback 接入。
5. Claude `--sdk-url` 或其他未公开内部协议只允许作为 internal_experimental，不进入默认路径。除非官方公开并承诺兼容，否则不要追逆向协议。
6. `capsule-code` 的 tmux+FIFO+log-tail/stream-json 只作为 Claude/Council 自动化参考，不能替代 Claude TUI mux，因为它无法完整使用交互式 TUI 的 /command、插件菜单和快捷键。
7. Provider capability/runtimeKind/protocolStability 必须协议化。UI 根据 capability 展示 model/mode/plan/stop/TUI 控件，不允许 provider 名字散落特判。
8. 模型、模型参数、权限选择先恢复为启动前配置能力；运行中修改只有在 provider transport 明确支持时才开放。
9. Timeline 必须走 adapter normalize -> canonical item -> UI。Codex/OpenCode 使用官方 event id/turn id/item id；Claude fallback 使用 JSONL uuid/line cursor 的 best-effort identity。前端文本/时间窗口去重只能作为 legacy fallback。
10. Council 作为独立模块/页面复用 provider runtime、timeline、catalog，不引入 agent-council 的 Python 生产运行时，不深度耦合普通 session。
11. Codex/OpenCode 的 native_local_server 必须通过真实多客户端同步验证：Web chat 发送、本地 TUI client 发送、历史 backfill 三者必须看到同一个 provider session timeline。若某 provider 的 TUI client 不能同步同一 session，不允许声称它支持 TUI continuity，应保留 zellij fallback。
12. 每个 provider runtime 必须有可观测诊断：Session Info 至少展示 runtimeKind、live source、provider session id、server/attach 状态、可恢复 attach 命令，以及最后一次 event cursor/error。
13. 必须保留明确回滚开关或 fallback 路径：Codex/OpenCode native server 失败时可以降级到 tui_mux_fallback 或 history-only，不允许静默卡在 thinking。
14. native_local_server 的安全边界必须明确：本地 server 默认只绑定 localhost 或受控地址，attach/auth token 不得泄漏到普通日志，WebSocket/HTTP client 必须绑定 RAH session/client 权限。
15. 切换主链路必须有 cutover gate：只有真实 provider smoke、history backfill、cross-client sync、interrupt、archive/exit 生命周期全部通过后，才允许把某 provider 从 fallback 切到默认 native_local_server。
16. 必须先落一个真实 provider 探针脚本，再做默认链路切换。探针至少能低风险验证 Codex app-server initialize/capability、OpenCode serve/session/attach command，并输出 provider 版本、runtime capability、失败原因。未通过真实探针的能力只能标为 unverified/unsupported/experimental。
17. 必须维护 provider runtime capability truth table，把 Codex/OpenCode/Claude 当前每项能力的状态写清楚：structuredLiveEvents、structuredControl、historyBackfill、tuiClientContinuity、crossClientSync、prelaunchConfig、runtimeConfig、interrupt、archiveLifecycle。UI 和文档只能引用这张表，不允许散落猜测。
18. 实现时要优先证明“不损失核心场景”：本地原生工作、移动端 Web chat 续接、历史浏览、archive/exit 生命周期。任何新 native server 路径如果损害这些场景，必须保留 fallback 并默认关闭该能力。
19. 状态命名必须严格区分：runtime feature 只能使用 available/unverified/unsupported/experimental；provider attach endpoint 可以单独显示 unavailable。不要把目标能力、探针结果和当前 UI 可用状态混成一个布尔值。
20. 人类验收必须记录 provider 版本、runtimeKind、probe JSON、Session Info 截图/文本、失败 session id。没有证据的能力只能保持 unverified，不能因为“理论上可行”进入默认路径。

执行顺序：
1. 先落 ProviderRuntimeKind 和 capability 边界，保证 UI 不再展示假能力。
2. 再落真实 native local server probe 和 capability truth table，先用脚本确认当前 provider 真实能力。
3. 再做 Codex native_local_server，保持 Web chat、本地 TUI client、history 三方一致；若后续 Codex 版本破坏 TUI client 同步，必须降级 capability 并保留 fallback。
4. 再做 OpenCode native_local_server，验证 Web chat、TUI attach、model variant、stop/abort。OpenCode 1.14.41 attach cross-client sync、real prompt abort、archive 已由 `scripts/native_local_server_probe.ts` 验证；model/variant 仍需 UI 启动路径继续验收。
5. 再稳定 Claude zellij/tui_mux_fallback，重点处理 archive/exit/surface lease/JSONL display，并确保 /command 等交互式 TUI 能力仍能从 TUI 使用。
6. 再收敛 canonical timeline identity 与 live/history merge。
7. 最后接入 Council 的最小可用 UI 与 runtime 复用。

验收要求：
- npm run typecheck 通过。
- 相关 runtime/web/provider tests 通过。
- `scripts/native_local_server_probe.ts` 或等价探针能输出 Codex/OpenCode 当前真实 runtime capability，并能区分 pass/fail/unverified/unsupported。
- Codex 和 OpenCode 的真实本地 server smoke 能证明：Web 发送能在 TUI client 看到，TUI client 发送能在 Web 看到，Stop 能中断且不退出 session，刷新 history 不重复不乱序。
- 对于 OpenCode，必须至少有一个可重复的 cross-client sync probe 证明：Web/API 发出的 marker 能在 attach client 中出现，attach client 发出的 marker 能被 server/session timeline 读到；否则只能标记 attach 可用但 crossClientSync 未验证。
- Codex/OpenCode 需要额外证明：Web chat 不再通过 zellij/keyboard 注入发送普通消息；普通 turn 状态来自 provider server event，而不是 prompt clean/ANSI 屏幕猜测。
- Codex 需要额外证明：官方 TUI remote client 能连接 RAH 管理的 app-server 并同步同一 thread；当前 probe 已通过，后续版本升级必须复验。若某次只能 fallback 到 app-server stdio 结构化控制，则 UI 必须显示 structured live 可用但当前 session 没有 attach endpoint。
- Codex 需要额外证明：`rah codex` 和 Web new 都走 RAH 预创建 thread -> remote TUI attach 的确定性绑定路径，不把 `thread/loaded/list` 的共享 server diff 或 provider history 首消息当作默认绑定依据。
- Claude fallback 能证明：本地 TUI、Web chat、Web TUI 接管/归还、archive/exit 状态同步基本可靠，不出现孤儿 zellij、残留遮盖或 archive 后空 pane。
- iOS/PWA 浏览 chat 不应误触发 TUI attach；只有进入 TUI view 才接管 TUI surface。
- 未实现或不支持的能力必须在 capability/UI 中明确表达，不允许按钮可点但实际无效。

明确不做：不恢复 Gemini/Kimi CLI 一等 provider；不自研 tmux 级 PTY mux；不把 RAH 做成 provider session DB 替代品；不为了统一 UI 隐藏 provider 差异；不把 Claude SDK/headless/stream-json 当作原生 TUI 无缝接续替代品；不采用 Claude --sdk-url 等未公开内部协议作为默认主线。
```
