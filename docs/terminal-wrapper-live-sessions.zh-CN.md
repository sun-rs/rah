# Terminal Wrapper Live Session 设计

## 1. 目标

RAH 需要支持这种使用方式：

- 用户在本机终端执行 `rah codex` 或未来的 `rah claude`
- 终端里仍然保持 **原生 provider CLI TUI 体验**
- 同时该 session 立即出现在 RAH Web UI 左侧 `live sessions`
- 用户离开工位后，可以在手机或平板上继续通过 Web UI 与这个 session 对话
- Web UI 发出的用户消息、AI 回复、permission、stop 等状态，终端里也能看到
- 这一切不通过 “从 history claim” 完成，而是直接属于同一个 live session

这个目标与当前 RAH 已有的 “daemon-owned live session” 不完全相同。当前 live 主线更接近：

- daemon 自己拉 provider live client
- Web UI 直接附着 daemon-owned session

而 `rah codex` 这条线要求的是：

- **本地原生 TUI 保留**
- **Web UI 成为同一个 session 的第二 surface**

## 2. 为什么不能照抄 hapi

hapi 的核心结构是：

- CLI wrapper 启动 agent
- hub 保存 session 状态
- web 远程控制 session

这会自然导向 `local / remote` mode：

- terminal 是 local owner
- web 是 remote owner
- 两者需要切换谁拥有当前输入面

这也是 hapi 里出现：

- “切到 remote mode 后，本地 terminal 不能继续正常输入”
- “要按键切回 local mode”

的根本原因。

RAH 不应该复刻这个模型。

### 2.1 hapi 的问题不是 UI 小毛病，而是 ownership 模型问题

如果系统把“原生 TUI 当前 stdin 的拥有者”当成真相，那么就必须回答：

- 当前谁拥有输入？
- 本地草稿和远端草稿如何合并？
- 光标、补全、slash menu、选择区如何同步？

这类问题最后通常都会退化成：

- 切换 local / remote mode
- 阻止其中一端继续输入

这不是 RAH 希望的产品边界。

## 3. 设计原则

### 3.1 daemon 仍然是唯一 session registry

RAH 已经有现成 daemon。

所以不应该再引入一个第二中心，例如：

- `rah hub`
- `rah codex`

分别维护不同的 session registry。

正确做法是：

- **现有 daemon 继续作为唯一 session registry / event broker / canonical owner**
- `rah codex` / `rah claude` 只是接入 daemon 的本地 wrapper surface

### 3.2 不同步未提交草稿，只同步已提交 turn

这是避免 hapi 式 mode switch 的关键。

#### 需要同步

- 用户已提交的消息
- AI 回复
- permission / question
- tool / observation
- interrupt / stop
- runtime status

#### 不需要同步

- terminal 中尚未回车的草稿
- web 输入框中尚未发送的草稿
- 光标位置
- 选区
- provider 原生 TUI 的瞬时 UI 状态

换句话说：

- **同步的是 canonical turn**
- **不同 surface 各自维护自己的 draft**

### 3.3 不再建 local / remote mode

RAH 需要的是：

- 一个 live session
- 多个 surface
- 同一个 operator group

而不是：

- local mode
- remote mode
- 两者切换

## 4. 核心模型

### 4.1 Session 仍然只有一个

`ManagedSession` 仍然是唯一 live session 真相：

- session id
- provider
- runtimeState
- providerSessionId
- capabilities

不为 wrapper 再造第二套 session 类型。

### 4.2 引入 surface 概念

一个 live session 可以有多个 surface：

- terminal surface
- web surface
- phone / tablet surface

surface 只描述：

- 当前接入端是谁
- 它能不能输入
- 它是不是当前 focus surface

surface 不是 session owner。

### 4.3 引入 operator group

RAH 当前已经有：

- `AttachedClient`
- `ControlLease`

但它还是以单个 client 为输入控制单位。

对于 `rah codex` 这种本地 wrapper 场景，需要升级成：

- 一个 **operator group** 可以持有 control
- 同一个 operator group 下可以有多个 surface

例如：

- terminal surface
- web surface

同属于一个 `operatorGroupId`

这样：

- 不同设备上的同一用户，不需要互相 claim
- 不同人的设备，仍然需要 claim / observe

### 4.4 ControlLease 从 client 级变成 group 级

当前：

- `holderClientId`

建议升级方向：

- `holderOperatorGroupId`
- 可选保留 `holderClientId` 作为当前活跃 surface 提示

这能保持：

- “只有一个控制主体”

同时允许：

- terminal 和 web 同时是这个主体下的两个 surface

## 5. 总体架构

### 5.1 `rah codex` / `rah claude` 的角色

wrapper 的角色不是第二个后端，而是：

1. 启动原生 provider CLI TUI
2. 向 daemon 注册一个 terminal-launched live session
3. 将 provider 活动持续桥接给 daemon
4. 接收 daemon 发来的远端 turn / interrupt / permission response

它是一个 **local terminal surface + provider bridge**。

### 5.2 组件分层

```text
terminal wrapper (rah codex)
  ├─ 启动原生 provider CLI TUI
  ├─ 采集 provider activity
  ├─ 将 canonical-ish activity 发给 daemon
  └─ 从 daemon 收到 remote command 后注入 provider

runtime daemon
  ├─ session registry
  ├─ canonical event broker
  ├─ control / operator group
  ├─ web API / WS
  └─ wrapper control channel

web ui
  ├─ 显示同一个 live session
  ├─ 发送已提交 turn
  └─ 接收 canonical feed
```

## 6. Wrapper 与 daemon 的勾连方式

### 6.1 新增本地 wrapper control channel

建议增加一条 **wrapper 专用的双向长连接**。

优先顺序：

1. localhost WebSocket
2. 未来如有需要，再评估 Unix domain socket

第一阶段不要过度设计，直接复用现有 daemon HTTP/WS 入口更稳。

### 6.2 wrapper 启动流程

`rah codex`：

1. 检查 daemon 是否存活
   - `GET /readyz`
2. daemon 不在则自动拉起
3. wrapper 建立本地 control channel
4. wrapper 请求 daemon 创建一个 terminal-launched session
5. daemon 返回：
   - `sessionId`
   - `operatorGroupId`
   - `wrapperToken` 或 connection identity
6. wrapper 启动原生 Codex CLI TUI
7. wrapper 开始桥接 provider activity
8. Web UI 立即可见该 live session

### 6.3 新增 wrapper 生命周期事件

建议 wrapper 向 daemon 上报：

- `wrapper.session.started`
- `wrapper.session.provider_bound`
- `wrapper.session.exited`
- `wrapper.surface.focus`
- `wrapper.prompt_state.changed`

其中最重要的是：

- provider session id 何时确定
- 当前 prompt 是否可安全注入远端输入

## 7. 输入模型

### 7.1 不同步 draft

terminal 和 web 各自有本地 draft：

- terminal 的未提交草稿属于 terminal
- web 的未提交草稿属于 web

二者不互相覆盖。

### 7.2 同步已提交 turn

任一 surface 提交后：

1. daemon 生成 canonical user turn
2. provider 处理
3. AI 回复回流 daemon
4. terminal 和 web 同时看到同一条 AI 回复

### 7.3 remote 输入注入策略

web 发来的 turn 不能粗暴立即写进原生 TUI stdin。

需要先看 wrapper 上报的 prompt state。

定义三种最小状态：

- `prompt_clean`
  - 当前在输入提示符，且本地 draft 为空
- `prompt_dirty`
  - 当前在输入提示符，但本地 draft 非空
- `agent_busy`
  - agent 正在运行，不在安全注入边界

行为：

- `prompt_clean`
  - 远端 turn 可立即注入
- `prompt_dirty`
  - 远端 turn 入队，不破坏 terminal 当前 draft
- `agent_busy`
  - 远端 turn 入队，等待下一个 clean prompt

这就是 RAH 要替代 hapi “切 mode” 的核心机制：

- **队列**
- **prompt 边界**
- **不抢输入权**

### 7.4 `queuedInput` 能力位真正变得有意义

当前 `SessionCapabilities.queuedInput` 已存在。

wrapper-launched native TUI session 应当把它设为：

- `true`

这样前端可以显式知道：

- 当前远端消息可能先进入 queue
- 而不是立即被 provider 接收

## 8. 为什么这会比 hapi 更好

### 8.1 不要求用户切 local / remote mode

用户在手机输入时，不需要：

- 抢走 terminal 的所有权
- 让 terminal 停止工作
- 按 Esc / space 才切回来

### 8.2 保留原生 TUI 体验

因为 terminal 里仍然跑的就是原生 provider CLI：

- Codex CLI
- Claude CLI

RAH 不去重造一个伪 TUI。

### 8.3 Web UI 仍然是真正 live

不是：

- 历史回放
- claim 历史
- 轮询文件才看到变化

而是 session 一启动就 live 出现在左侧。

### 8.4 冲突处理更真实

现实里真正的冲突不是：

- “web 和 terminal 哪边是 mode owner”

而是：

- “terminal 当前是否处在安全注入边界”

RAH 只解决真实冲突，不引入额外的产品概念。

## 9. 第一阶段实现范围

### 9.1 只做 `rah codex`

原因：

- Codex 已经是 RAH 的 reference adapter
- 当前 live 能力最完整
- 文档和测试基础都最好

### 9.2 第一阶段必须达成

- `rah codex` 能自动连接或拉起 daemon
- session 一启动就出现在 Web live sessions
- terminal 仍保持原生 Codex CLI TUI
- web 可发送消息
- AI 回复能同时在 web 和 terminal 中看到
- 不需要 claim history
- 不需要 local/remote mode

### 9.3 第一阶段暂不做

- terminal / web draft 同步
- 多用户并发写同一 wrapper session
- wrapper-owned full PTY mirror 产品化
- `rah claude` 同步开工

## 10. 协议与边界建议

### 10.1 尽量复用现有 canonical protocol

不要为 wrapper 引入新的主 feed 类型。

wrapper 应当尽量产出：

- `ProviderActivity`
- 或接近它的最小桥接消息

再由 daemon 继续映射成 canonical `RahEvent`。

### 10.2 不把 provider 原生 TUI UI 元素带进主界面

例如：

- 本地终端里某个特殊提示条
- 原生 slash 菜单
- provider 自己的 mode banner

这些都不该直接成为 Web UI 的新产品概念。

Web UI 仍然只吃：

- transcript
- permission
- tool
- observation
- usage
- runtime status
- terminal secondary surface

### 10.3 Wrapper 不应成为 session 真相 owner

wrapper 可以拥有：

- provider 进程
- prompt state
- local TUI

但 session registry / control / canonical event bus 仍应由 daemon 拥有。

## 11. 与当前 RAH 的关系

这条设计不是推翻现有架构，而是在其上扩展：

- 现有 daemon 继续存在
- 现有 Web workbench 继续存在
- 现有 provider adapter 继续存在

新增的是：

- `rah codex` terminal wrapper
- wrapper ↔ daemon control channel
- operator group 级 control 模型
- prompt-boundary aware queued input

## 12. 结论

RAH 要实现的不是 hapi 式：

- wrapper owner
- hub mirror
- local / remote mode switch

而是：

- **daemon-owned session registry**
- **wrapper-preserved native TUI**
- **multi-surface same-operator live session**
- **queue + prompt boundary，而不是 mode switch**

如果这条线做对：

- 用户在 mac 上保留原生 Codex / Claude CLI TUI
- 同时手机上的 RAH Web UI 立即看到 live session
- 两边都能继续工作
- 而且不需要再出现 “按 Esc 切回 local mode” 这类体验

