# `rah claude` Handoff 模式设计

## 1. 背景

当前 `rah codex` 的稳定实现依赖：

- daemon-owned live session
- terminal / web 双 surface
- wrapper 读取 provider session 文件

但 `Claude` 和 `Codex` 有一个关键差异：

- `Codex` 的 TUI 在自研 PTY relay 下还能基本保持可用
- `Claude` 的 TUI 对全屏重绘更敏感

因此在 `rah claude` 上，继续沿用 “native TUI -> 自研 PTY relay -> 外层 terminal” 这条路径，
会明显出现：

- 旧行残留
- 局部重绘失效
- 看起来“本该消失的内容没有消失”

这类问题不是 session 文件同步错误，而是 **TUI display fidelity** 问题。

## 2. 目标

第一阶段不再追求：

- terminal 和 web 同时双向驱动同一个本地原生 Claude TUI

而改成更接近 hapi 的模型：

- local mode: terminal 保持原生 Claude TUI
- remote mode: web 接管输入权
- transcript 继续来自 Claude session 文件

这是一种 **single-writer handoff** 设计。

## 3. 核心原则

### 3.0 复用原生 `~/.claude`

当前 `Claude` 方案不再像早期尝试那样给 `rah claude` 创建独立 `CLAUDE_CONFIG_DIR`。

原因是：

- `Claude` 原生支持 `--session-id <uuid>`
- `resume` 也天然是精确 id

所以在 `Claude` 上，隔离 config home 带来的收益并不足以抵消这些副作用：

- trust / theme / project onboarding 每次重新来
- `rah claude` 与裸 `claude` 像两个世界
- 同一 workspace 下的原生使用习惯被破坏

因此当前边界改成：

- `rah claude` 复用原生 `~/.claude`
- 通过 `--session-id / --resume` 做精确绑定
- `~/.rah` 只保留 RAH 自己的日志与状态

### 3.1 显示路径与数据路径分离

`rah claude` 里，主 transcript 继续来自：

- `~/.claude/projects/.../*.jsonl`

而不是来自 TUI 屏幕 relay。

这意味着：

- web UI 的主内容不依赖终端画面
- 终端画面只负责本地原生体验

### 3.2 单写者，多观察者

任意时刻只有一个 writer：

- terminal
- 或 web

两边都可以观察 transcript，但不能同时安全输入。

### 3.3 不做整屏 remote overlay

不复刻 hapi 那种完全覆盖原生 TUI 的 remote 界面。

当前目标是：

- local mode 时：terminal 完整原生
- remote mode 时：terminal 不再继续跑本地原生 Claude TUI
- 但只显示一条轻提示：
  - 当前由 web 控制
  - `Esc` 可恢复本地控制

## 4. 状态机

## 4.1 `local_native`

特点：

- 通过 `stdio: inherit` 直接启动原生 `claude`
- 没有自研 PTY 中继
- terminal 显示 fidelity 最好
- transcript 继续通过 session file scanner 同步到 daemon/web

## 4.2 `remote_writer`

特点：

- local Claude TUI 已退出
- web 发消息时，不再往本地 TUI 注入
- 改为单次启动：
  - `claude --print --resume <sessionId> <prompt>`
  - 或首轮尚未落盘时 `--session-id <sessionId>`
- 这条 one-shot 进程只负责消费一个远端 turn
- transcript 仍通过 session 文件回流到 daemon/web

## 4.3 reclaim

当处于 `remote_writer` 且当前没有 remote turn 运行时：

- terminal 用户可按 `Esc`
- wrapper 重新启动：
  - `claude --resume <sessionId>`
- 恢复 `local_native`

## 5. 为什么这比当前 PTY relay 更适合 Claude

因为这个设计不再要求：

- “同一个本地原生 Claude TUI 既保持原生显示，又继续被 web 远端写入”

相反，它接受：

- local / remote writer 需要切换

代价是：

- local writer 被 web 抢占时，terminal 里的原生 TUI 会退出

收益是：

- 本地原生显示 fidelity 明显提高
- 不再依赖自研 PTY relay 去兼容 Claude 的重绘模型

## 6. 与 hapi 的差异

相同点：

- local native TUI
- remote writer 与 local writer 分离
- transcript 主要靠 session 文件 / scanner

不同点：

- 不做完整 remote overlay
- 只做轻提示 + `Esc` reclaim
- daemon 仍是唯一 session registry / canonical owner

## 7. 第一阶段落地范围

第一阶段只要求：

- `rah claude` local native 启动
- `rah claude resume <providerSessionId>` 走确定性的 `claude --resume <id>`
- session file scanner 持续把 transcript 同步到 web
- web 发消息时切换到 remote writer
- remote turn 结束后 `stop/thinking` 恢复
- `Esc` 可以重新回到 local native

第一阶段不要求：

- terminal 在 remote mode 下继续保持原生 Claude TUI 活着
- terminal 与 web 同时写
- 远端 permission 全量桥到 web approval
- `claude --resume` 无 id 进入原生 session 选择列表

当前为了降低日常使用成本，web 接管的 `claude --print` 轮次默认使用
`--permission-mode bypassPermissions`。这表示：

- 本地 TUI 里发起的轮次，仍按 Claude 原生权限/信任流程处理
- web 接管发起的轮次，默认不在 web 弹 approval，而是自动放行
- 如需临时改回 Claude 原生策略，可以设置 `RAH_CLAUDE_REMOTE_PERMISSION_MODE=default`

### 7.1 为什么不支持原生 session picker

`Claude` 原生有三种不同入口：

- `claude`
- `claude --resume`
- `claude --resume <id>`

当前 `rah claude` 只支持前两条里可确定绑定的两种语义：

- 新会话：`--session-id <uuid>`
- 恢复指定会话：`--resume <id>`

不支持：

- `claude --resume` 无 id 进入原生 picker，再在 TUI 内人工选择

原因是这条路径启动时并不知道最终会选中哪个 session，wrapper 只能事后猜测 active
session 绑定，风险明显高于显式 id 绑定。

因此当前边界锁定为：

- `rah claude`
- `rah claude resume <providerSessionId>`

而不是：

- `rah claude --resume`
- 或任何依赖原生 picker 再手动选择 session 的模式

## 8. 实现切口

### 8.1 本地 native child

用 `stdio: inherit` 启动 Claude：

- 显示路径完全交给用户真实终端

### 8.2 remote print child

用 one-shot `claude --print` 驱动 web turn：

- 不承担显示
- 只负责把 prompt 写入同一 provider session
- 默认附带 `--permission-mode bypassPermissions`，避免 web 远端轮次卡在不可见的 CLI approval 上

### 8.3 session file scanner

继续作为统一 transcript 真相来源：

- `user`
- `assistant`
- `tool_use`
- `end_turn`

### 8.4 terminal hint

remote 模式下不覆盖屏幕，只提示：

- web 正在控制
- `Esc` 恢复本地

## 9. 后续推广

如果这套 handoff 模型在 `Claude` 上验证成功，可以评估是否推广到：

- `Codex`
- `Kimi`
- `Gemini`

推广标准不是“代码统一”，而是：

- 该 provider 的本地原生 TUI 是否比双向 relay 更值得保真
- 该 provider 是否有足够稳定的 session 文件可做 transcript 真相
