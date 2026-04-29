# RAH 架构对照与强化路线

这份文档回答三个问题：

1. `RAH / hapi / paseo / AionUi ACP 2.0` 各自最强的点是什么
2. RAH 应该吸收哪些成熟经验，哪些不该照搬
3. RAH 如果想继续往“最强架构”走，下一阶段应该怎么做

这不是“谁最好”的泛泛而谈，而是为 RAH 后续演化提供约束。

## 1. 当前判断

RAH 现在已经完成了：

- canonical event contract
- runtime-owned workbench
- `Codex / Claude / Gemini / Kimi / OpenCode` 五条真实 provider 主线
- history replay / claim / live upgrade / tool flow / browser smoke

因此，RAH 当前已经不是“架构是否成立”的阶段，而是“如何继续强化”的阶段。

对照其它成熟项目后，一个更准确的判断是：

- `RAH` 最强的是 **canonical protocol + provider-native adapter workbench**
- `hapi` 最强的是 **scanner / normalize / history visibility discipline**
- `paseo` 最强的是 **store-centric authoritative state machine**
- `AionUi ACP 2.0` 最强的是 **ACP runtime/session lifecycle 分层**

RAH 不应该推翻重来，而应该继续吸收这些成熟经验。

## 2. 四者对照

| 维度 | RAH | hapi | paseo | AionUi ACP 2.0 |
| --- | --- | --- | --- | --- |
| 主目标 | 本地 runtime-owned 多 provider 工作台 | 多 agent remote/local 控制与历史可见性 | 高完成度 agent 工作台与状态机 | 大规模 ACP backend runtime |
| 强项 | canonical protocol、provider-native adapter、真实 browser smoke | scanner、hook、normalize、可见性边界 | history/live authoritative state machine、store ownership | session lifecycle、permission resolver、client factory、ACP runtime 分层 |
| 主风险 | 状态所有权若分散，易回归 | scanner/hook 复杂度高 | 状态机实现成本高 | 容易把所有 provider 都拉进 ACP-first 思路 |
| 最值得学 | 保持现状 | 文件型 provider 的 scanner/hook toolkit、normalize-first | cursor/generation/authoritative applied | ACP subsystem 的 runtime/session 结构 |
| 不该照搬 | - | 整套 hub/runner | 整套 server/store 结构 | 整套 ACP runtime 替换现有 provider-native adapter |

## 3. 各家的成熟经验到底值钱在哪里

### 3.1 hapi

hapi 的价值不在 UI，而在两件事：

- **scanner / hook 体系**
  - 很适合 `Claude / Gemini / Kimi` 这类强依赖 transcript / session files 的 provider
  - 对“resume 后 session id 变化”“文件晚一点落盘”这类现实问题处理成熟
- **normalize-first**
  - 不该进主聊天区的内容，尽量在 translator / normalize 层就裁掉
  - 避免“前端最后兜底过滤”

RAH 已经在 Claude/Kimi/Gemini 上吸收了一部分，但还可以继续体系化。

### 3.2 paseo

paseo 的价值在于：

- **history/live authoritative 分层**
  - `agentTimelineCursor`
  - `historySyncGeneration`
  - `agentAuthoritativeHistoryApplied`
- **store-centric session state machine**
  - 页面只消费状态，不主导状态迁移
- **optimistic -> authoritative handoff**
  - 初始 optimistic create flow 和 authoritative history/live handoff 边界很清楚

RAH 已经学了它的方向，但还没完全学到它的“状态集中度”。

### 3.3 AionUi ACP 2.0

AionUi ACP 2.0 的价值不在“它能替代一切”，而在：

- **AcpRuntime / AcpSession / SessionLifecycle**
  - 明确把 runtime、session 聚合根、生命周期控制拆开
- **PromptExecutor / PermissionResolver / MessageTranslator**
  - 权限、prompt、translator 不是散落在一个 God object 里
- **ClientFactory**
  - 为 future ACP backend 预留了 process / websocket 两种 client 形态
- **fake ACP CLI + real ACP smoke**
  - 协议演进时可先用假 backend 回归，再上真实 CLI

这套东西非常适合未来的 **ACP provider 子系统**，但不应拿来替换当前已经跑通的 provider-native 路线。

## 4. RAH 该吸收什么

### 4.1 立刻继续吸收的

#### 从 paseo 吸收

- 把剩余页面副作用继续收回 store
- 把 history/live 的 cursor/generation 进一步做实
- 继续明确 optimistic -> authoritative handoff

这是 RAH 1.x 继续增强的最优先方向。

#### 从 hapi 吸收

- 为文件型 provider 建立更统一的 scanner/hook toolkit
- 继续坚持 normalize-first
- 把“内部事件过滤、历史去重、晚到 transcript 容忍”做成更明确的 provider 维护准则

这是 provider 数量继续变多时最能抗漂移的方向。

#### 从 AionUi 吸收

- 如果后续接更多 ACP backend，优先建设一个 **ACP sidecar subsystem**
- 把 permission bridge、session lifecycle、client factory 从一开始就设计清楚
- fake ACP CLI + real ACP smoke 这一套测试策略值得直接借鉴

但这应该是 **新增 ACP 子系统**，不是替换现有 adapter 主路由。

## 5. RAH 不该吸收什么

### 5.1 不该把所有 provider 都统一迁到 ACP-first

现在 `Codex / Claude / Gemini / Kimi / OpenCode` 已经有 provider-native adapter，而且真实链路已验证。

因此不应该为了“架构统一感”就把它们全部塞进 ACP runtime。

正确做法是：

- provider-native 的继续 provider-native
- ACP-native 的走 ACP subsystem

统一点在 canonical protocol，不在底层 transport 必须一致。

### 5.2 不该把 diagnostics 变成 auth 承诺

`hapi / paseo / AionUi` 都没有把“CLI 在 PATH”伪装成“provider 一定可用”。

RAH 现在已经把 diagnostics 收得比较对了：

- binary / version / basic launch
- 不承诺 auth

这条边界不该回退。

### 5.3 不该为了一个 provider 的新事件而频繁改 canonical protocol

正确顺序应该永远是：

1. 改 translator
2. 改 fixture / corpus / smoke
3. 只有 fallback 桶也容不下时，才改 protocol

这条原则已经写进维护文档，应继续坚持。

## 6. RAH 继续变强的路线

## 6.1 RAH 1.x 强化路线

### A. 状态机继续收口

目标：

- 页面只消费状态
- store 拥有 session/history/live 的迁移逻辑

参考来源：

- `paseo`

### B. provider drift toolkit 继续工程化

目标：

- scanner/hook/normalize 更统一
- 每个 provider 都有更明确的 corpus/coverage

参考来源：

- `hapi`

### C. ACP 子系统以 sidecar 方式孵化

目标：

- 不影响现有四条 provider 主线
- 先承载未来的 ACP backend

参考来源：

- `AionUi ACP 2.0`

## 6.2 什么情况下进入 RAH 2.0

只有在下面至少两条成立时，才值得把 ACP runtime 抬成更高优先级：

- 新增 provider 里 ACP backend 数量明显超过 provider-native backend
- 需要 process ACP 和 websocket ACP 并存
- permission / lifecycle / reconnect / auth 协调在 ACP backend 上反复重复
- fake ACP CLI 与真实 ACP smoke 已经成为常规开发需求

在那之前，RAH 最优路线仍然是：

- **强化现有 provider-native 主线**
- **把 ACP 作为新增子系统，而不是总架构替换方案**

## 7. 结论

如果目标是让 RAH 的架构继续变强，最合理的路线不是“重新设计一切”，而是：

- 继续保持 RAH 当前的 canonical protocol 主轴
- 吸收 `paseo` 的状态机集中度
- 吸收 `hapi` 的 scanner/normalize 纪律
- 吸收 `AionUi ACP 2.0` 的 ACP runtime 设计，但只用于未来 ACP 子系统

一句话总结：

**RAH 该做的是“在当前正确骨架上继续强化”，不是“为了追求统一而推翻重来”。**
