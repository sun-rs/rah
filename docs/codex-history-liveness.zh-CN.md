# Codex 历史 liveness 与 pending tool 收口边界

## 目标

Codex rollout 历史里可能出现这种状态：

- 最后一条是 `function_call`
- 后面没有 `function_call_output`
- TUI 显示过 `Conversation interrupted`
- Web 历史里却一直显示 tool `Running`

RAH 需要把这种“已经结束的历史”显示成 interrupted/failed，但不能把仍在运行的野生 TUI 或 RAH live session 误判成失败。

## 定义

- RAH 管理写手：RAH 自己拉起并仍可继续控制的 Codex session，例如 web live session、`rah codex` terminal wrapper。
- RAH 历史读取：Web 打开历史、翻页、replay provider history。它只读 rollout，不算 live，也不算写手。
- 外部写手：非 RAH 当前进程对 rollout 文件持有写或读写 fd，通常是用户自己开的裸 `codex` TUI。
- closed history：没有 RAH 管理写手、没有外部写手，并且 rollout 文件一段时间内没有变化。

## 收口规则

显式中断优先：

- rollout 里已经写入 `turn_aborted` 时，立即把未闭合 tool 标记为 interrupted。
- 这不依赖 EOF，也不依赖 liveness 判断。

EOF pending tool 只在 closed history 下收口：

- 如果有 RAH 管理写手，不收口。
- 如果 `lsof` 发现外部写手，不收口。
- 如果 rollout 文件最近仍在变化，不收口。
- 只有上述条件都不成立时，才把 EOF 处仍 pending 的 tool 标记为 interrupted。

## 为什么 RAH 自己打开历史不算 live

Web 历史读取会短暂打开 rollout 文件，但它不会继续写入 session，也不能代表 provider 仍在工作。

因此：

- 只读打开不会阻止 pending tool 收口。
- RAH 的 stored replay session 不算写手。
- 只有能继续 send/interrupt/archive 的 RAH live/terminal wrapper 才算 RAH 管理写手。

## 外部 TUI 的边界

RAH 会用 `lsof` 判断 rollout 是否有外部写手。

这能覆盖“外部 TUI 正持有文件写 fd”的情况。如果某个 provider 只在追加瞬间打开文件、写完立即关闭 fd，那么没有 wrapper 或 provider pid 元信息时，无法 100% 证明它仍在运行；RAH 会退回到“文件稳定 + 无写手”的 closed-history 规则。

精确 liveness 的强保证只能来自：

- 通过 `rah codex` 启动，由 RAH 管理生命周期。
- provider 在历史文件里记录 pid/session owner。
- provider 提供 app-server/thread status。

## UI 语义

- live / thinking：存在 RAH 管理写手，或 provider 事件明确仍在进行。
- external live：发现非 RAH 写手正在写 rollout。
- closed history：无写手且文件稳定，此时 EOF pending tool 可以显示为 interrupted。

这个边界避免两类错误：

- 已经被中断的旧历史不再永久显示 `Running`。
- 仍在运行的 live/wild TUI 不会被 Web 历史读取误判为失败。
