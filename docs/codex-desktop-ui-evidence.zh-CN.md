# Codex Desktop 会话 UI 证据

状态：版本绑定的产品行为研究，不是公共 API

复核日期：2026-07-10

## 1. 样本

本次检查的本机应用：

- App：`/Applications/Codex.app`
- `CFBundleShortVersionString`: `26.707.31428`
- Build：`5059`
- Electron：`42.1.0`
- 内置 Codex：`0.144.0-alpha.4`

应用的 `app.asar` 可以正常解包，前端是压缩后的 Electron/Vite bundle，并非加密二进制。但它没有源码映射，符号会变化，也没有证据表明这些 UI 代码是对外开放、可复制依赖的源代码。

因此证据分级如下：

- app-server Rust 协议：可依赖。
- Desktop bundle 中观察到的交互：可借鉴。
- bundle 内部函数、类名、DOM 和 CSS：不可依赖。

## 2. Turn 级“已处理”

当前 Desktop 将一次 turn 的过程收在一个可折叠区域中：

- 运行中：`Working` / `Working for {time}`
- 完成：`Worked for {time}`，中文为 `已处理 {time}`
- 用户中断：`You stopped after {time}`

计时以 turn 的开始、完成时间为依据，运行时每秒更新。完成后默认可以折叠；最终 answer 保持在折叠区域之外。

这解释了用户截图中的行为：commentary、reasoning、工具活动属于一次 turn 的处理过程，final answer 是该 turn 面向用户的终态输出。

## 3. 过程内容分组

Desktop 不是把每个原始事件都渲染成独立气泡，而是先分类，再组合连续 activity：

- reasoning/commentary
- commands
- file changes
- read/list/search files
- web searches
- MCP/tools
- subagent activity
- context compaction

多个连续命令可压缩为 `Ran multiple commands`，中文为 `运行了多个命令`。该命令组可以再次展开，形成两级折叠：

1. turn 处理过程整体折叠。
2. 过程内部的同类 activity 批次折叠。

Desktop 还会把 compaction 表达为紧凑的系统活动，而不是普通 assistant 消息。

## 4. 最终回答

最终回答的关键语义不是“最后一个 assistant 文本”，而是：

- `agentMessage.phase === final_answer`，或
- 在 phase 缺失时，由 turn 完成和 provider 兼容规则确定的终态 answer。

final answer：

- 不进入“已处理”折叠体。
- 保留主要 Markdown 阅读样式。
- 提供整段复制等 answer 级操作。

commentary：

- 属于 process。
- 视觉弱化。
- 默认随 turn process 一起折叠。

## 5. Activity 摘要

完成后的 process header 不是原始事件列表的简单计数。Desktop 会按 activity 语义生成摘要，例如：

- 运行了多个命令
- 编辑了文件
- 读取了文件
- 搜索了网页
- 调用了工具
- 启动或更新了 subagent

这说明摘要应由有语义的 item 投影生成，而不是由 React 遍历任意 FeedEntry 临时猜测。

## 6. 对 RAH 可直接吸收的设计

- Turn 是折叠、计时、终态和错误的边界。
- Final answer 与 process 是结构关系，不只是颜色差异。
- Activity batch 是 process 内部的第二级组合。
- active process 默认展开；completed process 默认折叠。
- failed item 应在折叠摘要中留痕，但不能把整个 turn 错判为 failed。
- subagent activity 是主 turn 的内部 activity；只有主 `turn/completed` 才能结束主 turn。

## 7. 不应照搬的部分

- RAH 不能绑定 Codex 的 React 组件或私有 bundle。
- RAH 不能把 Codex item union 直接定义成跨 provider 公共协议。
- RAH 不能牺牲 Claude、OpenCode、Council、Canvas 和跨设备 Web/PWA 边界。
- RAH 不能复制官方账号、云端同步或 remote-control 假设。

RAH 要学习的是“turn-first conversation projection”，不是把产品变成 Codex Desktop 克隆。
