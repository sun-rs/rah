# TUI Surface 生命周期设计

RAH 的 live session 和 Council 都可以打开原生 TUI 画面。这里的 TUI 画面只是一个 Web 侧显示/操作 surface，不等于 session 或 agent 本体。为了避免白屏、半截 replay、资源无限增长和 tmux 多 attach 绘图冲突，统一按以下边界处理。

## 术语

- `session`：Codex/Claude/OpenCode 的真实 live session。
- `agent`：Council 内的单个参与者。
- `Web TUI surface`：浏览器里的 xterm/Web TUI client。
- `detach`：释放 Web TUI surface，不关闭 session/agent。
- `archive/remove/stop`：真正结束 session 或 agent 进程。

## Session Live TUI

Session live TUI 跟随主页面注意力。

- 当前主页面正在看某个 live session 时，该 session 的 TUI 可以保活。
- 在同一个 live session 内切换 `Chat` / `TUI` 不触发 detach。
- 打开 Settings、Sessions、Info 等弹窗不算离开当前 session。
- 一旦主页面切换到其他 live session、workspace、Council、Canvas 或 Home，旧 session 的 Web TUI surface 自动 detach。
- 用户点击 TUI 内红色 `X` 时立即 detach。
- 自动 detach 只释放底层 Web TUI client，不把该 session 标记成“手动关闭”。用户回到该 session 并点击 `TUI` 时应自动重新 attach。
- 红色 `X` 是手动 detach；这时才显示 `Activate TUI`，由用户明确重新激活。
- `Hide` 当前 session 会 detach Web TUI surface，但不 archive session。
- `Archive` 才是一退全退。

因此同一时间最多只有一个 session live Web TUI surface 保活。Chat/headless client 不受影响。

## Council Agent TUI

Council terminal 是多 agent 观察/控制工具，不能每次切 tab 都销毁，也不能无限保留。

- 首次从 Agents 列表点击任意 agent 打开 running council 的 terminal 时，当前 live agents 会一次性进入 warm cache，方便快速扫视所有 tab 状态。
- Agents 列表点击是强 attach：即使该 agent 之前被红色 `X` 手动 detach，也会立即重新 attach。
- Terminal tab 点击是弱切换：如果该 agent 已被手动 detach，只切到该 tab 并显示 `Activate TUI`，不会自动解除 detach。
- `Activate TUI` 是强 attach。
- 用户打开过或首次预热过的 agent TUI 会进入 warm cache。
- Warm cache 最多保留 8 个 agent TUI surface。
- 超过 5 分钟未触达的非当前 agent TUI 可以被自动回收。
- “未触达”从用户离开该 agent TUI 时开始计算：例如先看 A 再看 B，A 从切到 B 的时刻开始计时；B 如果一直被看着 10 分钟，则关闭 terminal 后才从关闭时刻开始计时。
- 用户点击 agent TUI 内红色 `X` 时立即 detach，并显示 `Activate TUI`。
- 重新点击 `Activate TUI` 会重新建立该 Web surface。
- 关闭 terminal dialog 只是 hide，不改变 attach/detach 语义；当前 tab 会刷新 last-seen 时间后进入 TTL。
- Remove/Stop agent 才会结束该 agent 进程，并从 terminal 列表移除。

## Exclusive 与 Multi-client

- Claude/Gemini 当前走 tmux fallback，属于 exclusive TUI surface：同一时间只能有一个真实 attach。Web attach 会让其他 tmux viewer 退出显示控制，反之亦然。
- Codex/OpenCode native local server 属于 multi-client：Web chat、Web TUI 和本地 terminal client 可以共存。
- 如果 Codex/OpenCode 未来落入 tmux fallback，则按 exclusive 处理。

## 实现原则

- 不用弹窗开关决定 session TUI 生命周期；用主页面 active target 决定。
- 弹窗只影响是否可见，不等同于关闭 session。
- `detach` 必须只释放 Web surface，不影响 chat mirror/headless client。
- 资源回收由显式 `X`、主页面注意力切换、Council warm cache 上限和 TTL 共同完成。

## 验证

单元测试覆盖：

- session TUI 只有打开过且未 detach 时才算 active。
- 同 session 内 Chat/TUI 切换不 detach。
- active main session 切换或关闭时，前一个 session TUI detach。
- Council warm cache 最多保留 8 个 agent，并保留当前 active agent。
- Council TTL 只清理过期非当前 agent。
- 手动 detach 后仍保留可重新 activate 的访问记录。
- Agents list strong attach 会解除 manual detach；Terminal tab weak selection 不会解除 manual detach。
- Council TTL 从最后一次实际看该 agent TUI 的时间开始计算。
- removed/stopped agent 会从 cache 中移除。

浏览器 smoke：

```bash
npm run test:smoke:tui-surface-lifecycle-browser
```

该脚本使用隔离临时 `RAH_HOME` / `CODEX_HOME`、fake Codex TUI 和真实 Chromium，验证：

- 打开 session TUI -> 切 Chat -> 切回 TUI，不出现 inactive overlay。
- 打开 Settings 弹窗后关闭，不 detach 当前 session TUI。
- A session TUI 打开后切到 B session，再回 A 并点击 `TUI`，A 自动重新 attach，不显示 inactive overlay。
- 手动点击 Web TUI 红色 `X` 后显示 inactive overlay，并可重新 `Activate TUI`。

这个 smoke 不写入用户真实 workspace/sidebar/session 历史。
