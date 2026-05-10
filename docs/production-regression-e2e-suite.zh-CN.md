# RAH 生产回归专项测试设计

本文件定义 RAH 进入生产级自用前必须固定下来的回归测试集。目标不是证明模型回答质量，而是证明 RAH 的核心工作台能力没有回退：无缝接续、Chat 投影顺序、唯一性、中断控制、History 分页、TUI surface 管理、移动端可用性。

机器可读的 case 总账在 `scripts/regression_e2e_manifest.ts`。新增历史 bug 时，必须先补一个 case id，再修代码。

## 核心原则

1. 前端只消费统一 RAH timeline。

   无论后端来源是 `Codex app-server`、`OpenCode server`、`Claude zellij`、provider history file、WebSocket live stream，进入 UI 前都必须归一成 `RahEvent`。前端排序和唯一性只看统一投影账本，不按 provider 或 backend 分叉。

2. daemon 是 transcript ledger 的权威边界。

   adapter/provider parser 负责把 raw event 映射为 canonical identity。daemon reconciler 负责 dedupe、lifecycle identity、history/live 合并。前端只做 projection 和必要的本地 optimistic intent anchor。

3. Stop 和 interrupt 必须可验证。

   Web 输入被接受或进入 native TUI 队列后，Stop 必须立刻可见。Stop 结果可以由后端确认，但提示位置和重复数量必须由前端 projection 锁定，防止 notice 漂移。

4. Fake provider 是主回归，真实 provider 是 smoke。

   真实 CLI 会受账号、网络、quota、provider 版本影响，不能作为唯一 CI gate。确定性回归用 fake provider/app-server/history/zellij fixture；真实 provider 只做小集合 smoke。

## 测试分层

| 层级 | 目的 | 是否必跑 |
|---|---|---|
| Unit/contract | 锁定 projection、timeline identity、provider parser、runtime state machine | 每次改动必跑 |
| Fake daemon/browser | 用 fake provider 驱动真实 daemon + Web UI，断言 DOM 顺序/按钮状态 | 每次 UI/runtime 改动必跑 |
| Fake zellij/native TUI | 验证 surface lease、queued input、archive、exit、late frame | 每次 TUI/mux 改动必跑 |
| Real provider smoke | 验证真实 Codex/Claude/OpenCode 当前版本没有协议漂移 | 发布前/手动跑 |
| Manual mobile QA | iOS/PWA 输入法、滚动、触控、视觉布局 | 发布前/大 UI 改动后 |

## P0 场景

这些场景一旦失败，不能认为当前版本可交付。

| ID | 场景 | 最小验收 |
|---|---|---|
| `TRANSCRIPT-ORDER-001` | 气泡顺序 | 两轮对话固定为 `user1 -> assistant1 -> user2 -> assistant2`，刷新/重选 session 后不变 |
| `TRANSCRIPT-UNIQUE-001` | 唯一性 | live/history echo 不重复；streaming update 不追加新气泡 |
| `TRANSCRIPT-REPEAT-001` | 重复文本 | 连续发送两次“继续”必须显示两轮 |
| `INTERRUPT-ANCHOR-001` | 中断提示锚定 | 每个被中断 turn 最多一条 notice，后续中断不能移动旧 notice |
| `INTERRUPT-STATE-001` | Stop 可见性 | Web 输入被接受/排队后 Stop 立刻出现，完成/失败/中断后消失 |
| `INTERRUPT-MULTI-001` | 多次 Stop | 多次点击 Stop 不退出 TUI，不产生多条 notice |
| `QUEUE-INPUT-001` | queued input | TUI prompt dirty 时 Web 输入排队、可中断、prompt clean 后只发送一次 |
| `NEW-SESSION-001` | 新会话 | 首屏不显示 older-history loading，第一问只出现一次 |
| `REFRESH-LIVE-001` | 刷新恢复 | 刷新后 transcript 不重复、Stop 不残留 |
| `HISTORY-PAGING-001` | 历史分页 | 向上加载 older page 不跳滚动锚，不重复 live tail |
| `HISTORY-CLAIM-001` | history claim | replay 转 live 不重排、不重复 |
| `CODEX-EVENT-001` | Codex 非 chat event | `thread/goal/cleared` 等不变成吓人的红色 chat Event |
| `CLAUDE-ABORT-CONTEXT-001` | Claude aborted context | `<turn_aborted>` 不进入可见消息正文 |
| `CLAUDE-ZELLIJ-001` | Claude zellij | Chat/TUI/local terminal surface 切换互斥且可恢复 |
| `OPENCODE-STOP-001` | OpenCode Stop | Stop 中断 turn，不退出 TUI，后续可继续问 |
| `OPENCODE-MIRROR-001` | OpenCode mirror | server live 与 DB mirror 合并后不重复 |
| `TUI-SURFACE-001` | TUI surface | 同一时刻只有一个 active display/input surface |
| `TUI-EXIT-001` | TUI exit | provider/TUI client `/exit` 后 RAH 不保持 running，不被迟到帧复活；native-local-server provider session 可继续保留 |
| `ARCHIVE-001` | Archive | 关闭 live clients/zellij/pty，不删除 provider history |

完整 case 列表可执行：

```bash
npm run test:regression:e2e-plan
tsx scripts/regression_e2e_manifest.ts --markdown
```

正式浏览器 release gate：

```bash
npm run test:regression:e2e-browser
```

该 gate 必须运行真实 Codex、Claude、OpenCode provider smoke，不允许用 fake provider 当作交付依据：

- `scripts/codex-browser-smoke.sh`
- `scripts/claude-browser-smoke.sh`
- `scripts/opencode-browser-smoke.sh`

它会校验每家 provider 都报告 `ok=true`，并且每家都覆盖真实浏览器核心 case：

- `REAL-PROVIDER-001`
- `REAL-CHAT-ORDER-001`
- `REAL-CHAT-UNIQUE-001`
- `REAL-STOP-NORMAL-IDLE-001`
- `REAL-INTERRUPT-ONCE-001`
- `REAL-INTERRUPT-RECOVERY-001`
- `REAL-INTERRUPT-MULTI-TURN-001`
- `REAL-HISTORY-REPLAY-001`
- `REAL-HISTORY-CLAIM-001`
- `REAL-SECOND-TURN-001`

旧的 deterministic fake browser smoke 仍然有价值，但只能作为开发期保护和快速定位工具，不能用于“可交付给人类测试”的结论。

当前 release browser gate 覆盖：

| Case | 状态 |
|---|---|
| `REAL-PROVIDER-001` | real-provider covered |
| `REAL-CHAT-ORDER-001` | real-provider covered |
| `REAL-CHAT-UNIQUE-001` | real-provider covered |
| `REAL-STOP-NORMAL-IDLE-001` | real-provider covered |
| `REAL-INTERRUPT-ONCE-001` | real-provider covered |
| `REAL-INTERRUPT-RECOVERY-001` | real-provider covered |
| `REAL-INTERRUPT-MULTI-TURN-001` | real-provider covered |
| `REAL-HISTORY-REPLAY-001` | real-provider covered |
| `REAL-HISTORY-CLAIM-001` | real-provider covered |
| `REAL-SECOND-TURN-001` | real-provider covered |

当前 release browser gate 聚焦真实 provider 的核心痛点：Chat 气泡顺序、重复气泡、Stop 消失、重复 Stop、中断提示唯一且锚定、history replay、claim 后继续发送。P1 移动端输入法、TUI surface 视觉细节、Council UI 仍需要额外 fake/browser/manual QA。后续新增历史 bug 时，先在 manifest 增加 case，再补对应 browser 或 runtime gate。

## 推荐命令矩阵

快速开发 gate：

```bash
npm run typecheck
npm run test:web
npm run test:provider-contracts
npm run test:regression:e2e-plan
```

runtime/TUI gate：

```bash
npm run test:runtime
npm run test:zellij-tui-auto
npm run test:regression:e2e-browser
npm run test:smoke:native-browser
```

跨浏览器 browser smoke：

```bash
npm run test:smoke:native-browser
npm run test:smoke:native-browser-webkit
npm run test:smoke:native-browser-firefox
```

真实 provider smoke：

```bash
npm run test:regression:e2e-browser
npm run test:smoke:codex-browser
npm run test:smoke:claude-browser
npm run test:smoke:opencode-browser
```

真实 provider smoke 是交付人类测试前的正式门槛。失败时必须先区分：RAH 回归、provider 版本漂移、账号/quota/网络问题。

## Browser E2E 断言标准

浏览器测试不能只看 HTTP 成功，必须断言 UI：

1. 气泡 DOM 顺序。
2. 每类气泡数量。
3. Stop 按钮出现/消失。
4. interrupt notice 位置。
5. 刷新后 transcript 不重复。
6. 打开/关闭 TUI 后 Chat 仍可发送。
7. Archive 后 live session 从侧栏消失。
8. 截图保存到 `test-results/browser-e2e/...`，失败时必须能复盘。

## 新 bug 进入流程

1. 先在 `scripts/regression_e2e_manifest.ts` 增加或更新 case。
2. 如果能 fake，优先写 unit/fake browser 自动化。
3. 如果只能真实 CLI 复现，先写 manual/real smoke case，并说明阻塞原因。
4. 修复代码。
5. 跑 case 对应命令。
6. 再跑快速 gate，确认没有破坏既有场景。

## 当前自动化缺口

1. 部分 P0 已有 unit 覆盖，但缺 DOM 级 fake browser 断言。
2. 真实 iOS/PWA 输入法行为仍需要 manual QA 或 WebKit + 真机补充。
3. Codex/OpenCode native server 多客户端同步需要继续扩大真实 provider smoke。
4. Council UI 目前是 P2，暂不进入核心 release gate，但要复用同一套 provider/model/mode 控件测试。
