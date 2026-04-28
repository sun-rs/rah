# `rah codex` 真实终端 handoff 模式设计

## 1. 目标

`rah codex` 现在开始从“自研 PTY relay 驱动原生 Codex TUI”迁到更接近 `rah claude` 的 handoff 模式：

- local mode：Codex 原生 TUI 直接运行在用户真实 terminal
- remote mode：web 接管输入，terminal 进入固定 handoff 面板
- transcript：继续以 Codex rollout / session 文件为主真相
- control：继续使用 Codex app-server 做远端 turn / permission / interrupt
- web-first：当 provider session 尚未绑定时，web 第一条消息会先用 Codex app-server 创建 thread，再绑定到当前 terminal wrapper

这条线的目标是：

- 保住原生 terminal 显示 fidelity
- 继续支持 web 接力
- 不要求 terminal 与 web 同时双写

## 2. 当前边界

### 2.1 仍保留 isolated `CODEX_HOME`

`rah codex` 与 `rah claude` 的关键差异是：

- Claude 可以通过 `--session-id / --resume <id>` 做强确定性绑定
- Codex 新建会话仍没有同等级别的“预注入 session id”入口

所以 Codex 继续保留：

- wrapper-owned isolated `CODEX_HOME`

这保证：

- `rah codex` 新开的 session 不会误绑到外部裸 `codex` 的 live session

### 2.2 single-writer handoff

任意时刻只有一个 writer：

- terminal
- 或 web

因此：

- terminal 正在本地跑 turn 时，web 只能观察
- web 接管后，terminal 不再继续承担输入
- `Esc` 用于拿回本地控制

### 2.3 transcript 继续来自 rollout

`rah codex` 的主 transcript 仍然主要来自：

- rollout 文件
- 必要时辅以 app-server 的 control/runtime signal

这意味着：

- terminal 显示路径和 web 数据路径已经分离

历史读取与 live 判断的边界见 [Codex 历史 liveness 与 pending tool 收口边界](./codex-history-liveness.zh-CN.md)。核心原则是：RAH 只读历史不算 live；只有 RAH 管理写手或外部写手才阻止 EOF pending tool 收口。

## 3. local / remote 模式

### 3.1 `local_native`

- 通过原生 `codex` / `codex resume <id>` 直接运行在真实终端
- 不再通过自研 PTY relay 承载显示

### 3.2 `remote_writer`

- web 发消息时，不再往本地终端 TUI 注入字符
- wrapper 改为：
  - 保留 session 绑定
  - 用 Codex app-server 对同一 thread 发 `turn/start`
- 如果 web 抢在 terminal 第一条之前提交，wrapper 会停止空白 native TUI，通过 app-server `thread/start` 创建 thread，并把当前 wrapper session 绑定到这个 thread
- terminal 切到 handoff 面板，显示：
  - 模式
  - 状态
  - session id
  - 当前 prompt 预览
  - `Esc` reclaim 提示

### 3.3 reclaim

当 remote turn 空闲时：

- terminal 用户按 `Esc`
- wrapper 再次启动本地原生 `codex resume <threadId>`

## 4. 远端控制面

Codex 这条线与 Claude 不同的优势是：

- 已经有 app-server
- 已经有 `thread/resume`
- 已经有 `turn/start`
- 已经有 `turn/interrupt`

因此 `rah codex` 的 remote writer 不必像 Claude 那样走 one-shot `--print`，而可以继续复用：

- `createCodexAppServerClient()`
- `thread/resume`
- `turn/start`
- `turn/interrupt`

## 5. 当前迁移阶段

当前这份文档描述的是：

- **phase 1 handoff migration**

也就是：

- CLI 入口已经开始切到真实 terminal handoff wrapper
- rollout/app-server/canonical event 仍尽量复用原有稳定层
- Codex 旧 PTY relay wrapper 已删除，真实 terminal handoff 是唯一 `rah codex` 路径

## 6. 非目标

当前阶段不承诺：

- TUI 内部 `/new` / `/resume` 自动 rebind
- terminal 与 web 同时双写
- handoff 模式一开始就完全覆盖旧实现的所有边角体验

这条线当前的目标是：

- 先把 `rah codex` 拉到和 `rah claude` 一致的真实 terminal handoff 架构
- 再逐步收边角
