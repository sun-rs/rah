# RAH Agent OS：Room-first 架构与生态借力路线

> 状态：目标架构提案，不描述当前 `main` 已实现行为。
>
> 调研快照：2026-08-23（Asia/Shanghai）。外部项目的能力、许可证和维护状态会变化，实际引入前必须重新核对上游。

## 1. 决策摘要

RAH 的长期第一等对象应从 Provider Session 上移为 `Room`：用户面对的是一个主题、会议或协作空间，真人与 agent 都是参与者；各家 CLI/harness 的原生 session 只是某个 agent 为完成 Room 工作而产生的内部 `RunAttempt`。

目标所有权：

- RAH 拥有 Room、成员、消息、线程、任务、决策、产物、审查和 Run 生命周期。
- agent identity 与 provider/runtime 解耦；同一个角色可以在不同 Run 中切换 Codex、Claude Code、Kimi Code、Grok、DeepSeek 等原生 harness。
- provider/harness 拥有自己的认证、订阅、模型配置、原生 session、内部历史、thinking 和工具呈现。
- RAH 不再把 provider transcript 解析成 Room 对话真相；原生 session 只作为可附着的诊断/工作现场。
- agent 通过带 schema 的 MCP/CLI bridge 显式 pull Room 消息并提交结构化消息、任务状态、产物和审查结果。
- 任意 CLI 至少可以作为 Generic PTY Run 存在；富语义通过 bridge、ACP 或少数受预算约束的原生增强获得。

一句话边界：

> RAH 统一“谁在做什么、产出了什么、证据是什么、谁审查过”，不统一“每家 CLI 如何 thinking、如何画原生 plan、如何展示内部工具卡片”。

这项方向与当前 provider-session-first 设计存在战略差异，因此必须渐进迁移。现有 Session/history 能力先作为 Legacy Run Inspector 保留，不能在新协议稳定前删除。

## 2. 为什么必须转向 Room-first

假设最佳效果来自“各家模型 + 各家原生 harness”，则不同 runtime 会同时拥有：

- 不同订阅和登录体系，不能假定 API key 可以跨 harness 复用。
- 不同 session/new/resume/steer/permission/plan 语义。
- 不同 history、stream、tool、thinking 和 artifact 表达。
- 不同的原生 TUI 操作与升级节奏。

在此条件下，统一 UI 有三种不同难度：

| 统一目标 | 可行性 | 长期成本 |
| --- | --- | --- |
| 启动、PTY、停止、资源和终端 | 高 | 可控 |
| Room、消息、任务、产物、审查 | 高 | 可控，且与 provider 无关 |
| 完整复刻所有原生 transcript/plan/tool/permission | 低 | 随 provider 数量和升级频率持续放大 |

因此，继续扩张 provider transcript parser 会让 RAH 的维护量近似增长为：

```text
providers × lifecycle variants × history variants × surfaces(Web/PWA/Canvas) × reconnect/resume races
```

Room-first 把主产品复杂度改为一套 RAH 自己控制的协作协议；provider 差异退回到启动、最小控制和可选增强层。

## 3. 产品语言与对象层级

### 3.1 命名

建议内部协议使用 `Room`，中文 UI 使用“主题”。

- “Session” 已经被 provider 原生 session 占用，不适合作为新的协作聚合根。
- “Council” 暗示必须有多个 agent，不适合一个人类 + 一个 agent 的普通场景。
- “会议”容易被理解为短时同步活动；RAH Room 可能持续数天并包含异步任务。
- “主题”可以同时表达一对一对话、多 agent 会议、长期项目讨论和审查空间。

Council 不再是一条独立产品路径，而是 Room 的一种参与者模板或协作模式。

### 3.2 聚合关系

```text
Workspace
└── Room / Topic
    ├── Membership
    │   ├── HumanParticipant
    │   └── AgentParticipant
    ├── Message / Thread
    ├── Task / Dependency / Decision
    ├── Artifact / Review
    └── RunAttempt
        ├── RuntimeProfile
        ├── opaque nativeSessionId
        ├── workspace/worktree
        └── terminal/process reference
```

### 3.3 Agent、Runtime、Session、Run 必须解耦

| 对象 | 所有者 | 稳定性 | 说明 |
| --- | --- | --- | --- |
| `AgentParticipant` | RAH | 跨 Run 稳定 | 角色、名称、职责、Room 成员关系 |
| `RuntimeProfile` | RAH 配置 + harness | 可版本化 | provider、命令、模型、认证 profile、能力 |
| `ProviderSessionRef` | provider | opaque | 原生 session id，只用于 attach/resume/诊断 |
| `RunAttempt` | RAH | 不可变记录 | 某 Task 使用某 RuntimeProfile 的一次尝试 |

切换 provider 时创建新的 RunAttempt，不在一个原生 session 内热迁移。交接使用显式 handoff package：

- Task、验收标准和约束。
- 已确认决策与未解决问题。
- Git commit、branch、worktree 和 diff。
- 测试、截图、报告及其它 artifact。
- 相关 Room 消息引用。

不得依赖复制隐藏思维过程或完整 provider transcript 来完成 handoff。

## 4. Canonical Room Ledger

### 4.1 Room 才是协作真相

Room ledger 至少拥有以下事件：

- `room.created / room.updated / room.archived`
- `membership.added / membership.removed / membership.role_changed`
- `message.posted / message.acknowledged`
- `thread.created`
- `task.created / task.claimed / task.state_changed`
- `decision.recorded`
- `run.requested / run.started / run.status_changed / run.ended`
- `artifact.published / artifact.revoked`
- `review.submitted / review.resolved`
- `control.requested / control.acknowledged`

每个事件必须具有稳定 ID、Room 内单调 cursor、actor、时间、幂等键和 schema version。WebSocket/SSE 只是传输；Room cursor 才是顺序、重放和缺口恢复依据。

### 4.2 消息类型保持小而稳定

第一版公开消息类型建议限制为：

- `message`
- `question`
- `proposal`
- `decision`
- `status`
- `result`
- `review`
- `system`

Task、Artifact、Review 是独立对象，消息只引用它们，不把所有数据塞进自由文本。

### 4.3 不解析 agent 打印的 JSON

agent 不应在 TUI stdout 中打印一段 JSON 供 RAH 扫描。正确路径是调用工具：

```text
room_join
room_inbox_pull
room_message_post
room_wait_new
task_claim
task_update
artifact_publish
review_submit
run_set_status
```

工具参数经过 protocol validator；服务端生成 message ID、actor、时间、顺序和权限字段。自由正文仍可使用 Markdown 与结构化 content parts，所以 Room UI 可以稳定显示代码、表格、图片和链接。

不支持 MCP 的 harness 使用同一协议的 CLI facade：

```bash
rah room inbox pull --room <id> --after <cursor> --json
rah room message post --room <id> --type result --content-file result.md
rah task claim <task-id>
rah artifact publish ./report.html --kind interactive-html --task <task-id>
rah review submit --task <task-id> --file review.json
```

CLI/MCP 只是两种 transport facade，必须进入同一 Room service，不得维护两套语义。

### 4.4 Pull、wake 与 acknowledgement

建议状态分层：

```text
queued
  -> available       已进入目标 participant inbox
  -> wake_injected   只证明 bridge/terminal 收到唤醒
  -> pulled          agent 已拉取消息正文
  -> acknowledged    agent 显式接受任务/问题
  -> responded       已发布对应消息
  -> verified        满足 Task 的外部验收条件
```

- `wake_injected` 不能推进 read/accepted cursor。
- Generic PTY 文本写入只能声明 `terminal_injected`，不能冒充 harness 已处理。
- agent 忙碌时消息停留在 inbox；不并发向同一原生 session 注入多个 turn。
- 不支持运行中 steer 的 harness 把 guide 明确标记为“下一轮待处理”，不能显示成已接受。
- completion 必须来自结构化 task/result/review action 或 verifier，不能由进程退出或 stdout 文案推断。

### 4.5 长 Room 的上下文边界

`room_inbox_pull` 必须游标分页，不向 agent 每次重发完整历史。可发送：

- cursor 之后的新消息。
- 当前 participant 的 task/control 变化。
- Room state revision。
- 可选的最新决策/摘要快照引用。

新 agent 加入长期 Room 时获得经过 provenance 标记的 briefing：目标、决策、任务、关键 artifact 和未解决问题，而不是所有闲聊全文。

## 5. Execution Plane 与能力分级

### 5.1 最小 Run 信封

RAH 不解析 provider session 内容，但仍需管理最小执行信封：

```ts
type RunAttempt = {
  id: string;
  roomId: string;
  participantId: string;
  taskId?: string;
  runtimeProfileId: string;
  provider: string;
  nativeSessionId?: string;
  workspace: string;
  worktree?: string;
  terminalRef?: string;
  capabilities: RunCapabilities;
  status: RunStatus;
  startedAt?: string;
  endedAt?: string;
};
```

`nativeSessionId` 对 Room 协议不透明。它可以被 Legacy Run Inspector 用来打开 provider 原生历史，但不能反向生成 Room message。

### 5.2 能力等级

| 等级 | 要求 | RAH 可承诺的体验 |
| --- | --- | --- |
| L0 Generic PTY | CLI 可启动 | terminal、输入、resize、停止、退出状态 |
| L1 Room Bridge | 可调用 shell 或 MCP | 消息、任务、状态、artifact、review |
| L2 ACP/结构化 agent | ACP 或同等协议 | prompt/update/tool/permission/plan/session capability |
| L3 Native Enhancement | RAH 专有 adapter | 少数 provider 的原生 history/resume/steer 增强 |

规则：

- 新 harness 默认从 L0/L1 开始，不因缺少 transcript parser 阻止使用。
- L2 优先采用公开协议和 capability negotiation。
- L3 必须有明确维护预算与淘汰机制，不能无限增加。
- UI 必须展示真实 capability，不伪造跨 harness parity。

### 5.3 每个 Run 只能有一个 PTY owner

如果 RAH 直接拥有 PTY，则 Herdr/tmux/Orca 只能作为外部终端或诊断工具；如果 Run 由 Herdr server 拥有，RAH 必须通过 Herdr socket/CLI 控制，不能再次打开同一 PTY master。

这条规则避免双 attach、重复输入、scrollback 分叉和 stop 所有权不清。

## 6. Artifact 与 Review Plane

### 6.1 显式发布而不是路径推断

Artifact 发布至少包含：

- `kind` / MIME。
- 内容 hash 与大小。
- producer participant/run/task。
- 原始 locator 或 RAH-owned object id。
- 生命周期与可读状态。
- 可选 thumbnail/preview metadata。

支持类型可以包括：

- source file / patch / diff
- image / video / audio
- interactive HTML
- Markdown / PDF / Office 文档
- CSV / table / chart
- test report / benchmark / browser screenshot
- archive / binary delivery

RAH 只渲染已发布且校验通过的 artifact。回复中的裸路径可以保持普通链接，但不能自动获得 artifact truth。

### 6.2 Review 是独立工作对象

Review 不应是某个 Chat 卡片的临时 sidebar。它应关联：

- Task 与具体 RunAttempt。
- frozen diff/base/head。
- reviewer participant/runtime。
- inline comments 与 severity。
- test/evidence artifact。
- disposition：approve/request_changes/blocked。

不同模型的独立审查必须能在同一 Review Center 并列比较，不能靠多数票自动通过。

## 7. 多 agent 工作流

### 7.1 确定性 orchestration owner

Task graph、lease、retry、timeout 和 gate 由 daemon 的确定性状态机拥有；lead agent 可以建议分解和分配，但不能成为唯一调度真相。

典型高风险工作流：

1. 人类或 Spec agent 给出目标和可验证验收条件。
2. 多个异构 agent 独立提案，默认互相不可见。
3. Synthesizer 比较分歧、约束和证据。
4. Implementer 在隔离 worktree 中执行。
5. 不同 provider 的 Reviewer 只读取需求、diff、测试和 artifact，不读取实现者隐藏思维。
6. Verifier 实际运行测试、浏览器或数据校验。
7. 高风险 gate 由人类批准，低风险 gate 按显式规则收敛。

### 7.2 防止 agent 聊天空转

- 使用 membership、mention、thread subscription 和 task assignment 控制投递。
- 设定最大轮次、时间、成本和并发预算。
- 区分 proposal/challenge/rebuttal/evidence/decision 阶段。
- 相同 provider/model 的重复意见不能伪装成独立证据。
- agent 发布 `status` 不应自动唤醒所有其它 agent。

### 7.3 Runtime routing

RuntimeProfile 应记录 harness、模型、版本、认证 profile、权限和能力。Router 可以依据 RAH 自己的历史数据建议：

- 任务类型通过率。
- 人工返工率。
- 审查发现有效缺陷的比例。
- 平均时间、成本和失败率。
- 大历史 resume 与 bridge acknowledgement 可靠度。

路由建议必须可解释且可由用户覆盖。一次 RunAttempt 绑定一个不可变 profile snapshot，不能在执行中偷偷换模型。

## 8. Room-first UI 信息架构

Room 页面是一等工作面：

```text
Room Header: 标题 / 成员 / 状态 / 成本 / 菜单
├── Messages & Threads
├── Participants & Runs
├── Tasks & Decisions
├── Artifacts
└── Reviews
```

统一 composer 支持：

- 向 Room 发布普通消息。
- `@participant` 定向投递。
- 回复 thread。
- 从消息创建 Task/Decision。
- 附件与 artifact。

点击 agent 后打开 Run Inspector：

- runtime/provider/model/profile。
- 原生 session ref。
- 原生 terminal。
- 私有运行日志与 worktree。
- stop/restart/replace runtime。

默认 Room feed 不展示 provider thinking、内部工具卡和轮询调用。agent 应显式发布简明计划、假设、证据、进度、阻塞、结果和审查意见。

## 9. 外部项目能力地图

### 9.1 采用等级

本文使用四档：

- **直接集成**：通过公开协议、CLI、socket 或 SDK 作为可替换边界使用。
- **选择性移植**：许可证允许，但只复制小型、独立、能长期自行维护的模块，并保留 attribution/provenance。
- **协议/产品借鉴**：学习数据模型、状态机或 UX，不形成代码依赖。
- **不作为核心依赖**：闭源、许可证、所有权冲突或维护风险不适合成为 RAH truth owner。

### 9.2 Raft

来源：

- [Raft External Agents](https://docs.raft.build/features/agents/external/)
- [raft-external-agents](https://github.com/botiverse/raft-external-agents)

最有价值：

- 人类和 agent 使用同一成员、频道、线程、任务与附件模型。
- external agent 自己拥有 runtime/auth；bridge 只负责带鉴权的 wake，agent 通过 CLI pull 消息正文。
- `wake_injected` 不等于模型读取，activity hook 也只作为 self-reported telemetry。
- 未读、mention、Activity、DM、长期 agent identity 是 Room OS 必需的协作产品能力。

RAH 应吸收：

- external agent identity + device/profile login 思路。
- wake 与 message body 分离、transport proof 不推进 read cursor。
- channel/thread/task/file 作为协作域，而不是 provider transcript 的副产品。

不能直接采用：

- Raft 核心聊天服务端没有公开到可作为 RAH 本地底座的程度。
- 公开 external plugin 目前只是特定 bridge，不是完整 Room store。
- 不应让 RAH 的本地数据和退出能力绑定到 Raft 托管服务。

采用级别：**协议/产品借鉴**；未来可提供可选 Raft connector，但不作为 RAH canonical store。

### 9.3 Herdr

来源：

- [herdrdev/herdr](https://github.com/herdrdev/herdr)
- [Socket API](https://github.com/herdrdev/herdr/blob/master/docs/next/website/src/content/docs/socket-api.mdx)
- [motionharvest/herdr fork](https://github.com/motionharvest/herdr)

最有价值：

- Rust server/client、named session、workspace/tab/pane、detach/reattach、远程 attach 和 session restore。
- newline-delimited JSON local socket；Unix 使用 Unix socket、Windows 使用 named pipe，并支持事件订阅。
- socket schema 覆盖 workspace/tab/pane、agent、worktree、resource events 与 `session.snapshot`；CLI wrapper 可避免客户端手写传输细节。
- `agent.prompt` 可以原子地发送 prompt 并等待状态转换，避免调用方自己拼接 send/wait 产生竞态；但该状态仍不能替代 RAH 的 Task acknowledgement。
- provider 未适配时仍能以真实 terminal 工作；状态增强不必成为 transcript truth。
- upstream 当前为 Apache-2.0，代码集成许可证相对友好；引入前仍需核对具体版本和第三方 notices。

RAH 可借力：

1. 首选做一个隔离 `HerdrRunnerAdapter` spike，通过 socket/CLI 创建 pane、读取状态、attach 和 stop。
2. 如果 spike 证明跨平台、生命周期和升级边界可靠，可让 Herdr 成为可选 PTY owner；RAH 保持 Room/Task truth。
3. 如果引入成本过高，至少吸收其 server/client、session restore、socket event 和 pure render 纪律。

风险：

- RAH 当前 daemon 已拥有 PTY/runtime；不能同时让两个 owner 控制同一 Run。
- Herdr 的 working/blocked detection 只能作为 diagnostics，不得成为 Task completion 或 Room message truth。
- motionharvest 是带 UI 改动的 fork；基础协议优先跟 upstream，fork 只作 UX 参考。

采用级别：**直接集成候选（sidecar/socket）**，不建议把 Rust runtime 内嵌进 Node daemon。

### 9.4 Orca

来源：

- [stablyai/orca](https://github.com/stablyai/orca)
- [Orca orchestration guide](https://github.com/stablyai/orca/blob/main/skill-guides/orchestration.md)
- [Native Chat experimental setting](https://github.com/stablyai/orca/blob/main/src/renderer/src/components/settings/NativeChatExperimentalSetting.tsx)

最有价值：

- parallel worktree、WebGL terminal、远程 SSH worktree、diff 注释、GitHub/Linear、内置浏览器、文件/图片/PDF 预览。
- orchestration 明确区分 Run、Task、Dispatch、worker_done、escalation、ask/reply 和 decision gate。
- worktree/terminal/dispatch 命令返回结构化 receipt，适合作为可测试的执行契约。
- MIT 许可证允许选择性移植，但其 Electron/renderer/runtime 规模很大。

RAH 应吸收：

- `Run -> Task -> DispatchAttempt` 数据模型与 `worker_done` authority。
- worktree lifecycle receipt、setup state、ready/blocked/failed 分层。
- diff comment 回送 agent、远程 workspace、browser/design inspect 等大功能的 UX。
- decision gate 与 coordinator/worker handoff 区分。

不建议：

- 不把整个 Orca Electron 栈嵌入 RAH Web/PWA。
- 不依赖其 Native Chat 作为 canonical truth；上游仍明确标注 transcript fidelity/streaming/terminal parity 为实验性。
- 不直接复制大模块；优先通过 Orca CLI 做互操作实验，或只移植小型 MIT 模块并维护 provenance。

采用级别：**协议/UX 借鉴 + 可选 CLI connector**；选择性移植必须逐模块评审。

### 9.5 Multica

来源：

- [multica-ai/multica](https://github.com/multica-ai/multica)
- [CLI and Agent Daemon Guide](https://github.com/multica-ai/multica/blob/main/CLI_AND_DAEMON.md)
- [Multica License](https://github.com/multica-ai/multica/blob/main/LICENSE)

最有价值：

- Issue board、agent assignment、本地 daemon/runtime 注册、task queue、run history、retry、review 和 self-hosting。
- server 通知 + daemon polling backstop 的离线恢复思路。
- agent task 使用 task-scoped credential，而不是直接复用人类 PAT，是 RAH 权限隔离的重要参考。
- issue/run message 支持 sequence 增量读取，适合研究长任务日志边界。

RAH 应吸收：

- Issue→Task→RunAttempt→Review 的领域模型。
- runtime registry、lease、queue、retry/backoff 和 offline diagnostics。
- task-scoped identity/credential、agent 不能冒充人类用户的安全原则。
- skills 与 agent profile 绑定、runtime usage/activity 统计的产品设计。

不能直接作为核心代码依赖：

- 当前许可证是带附加限制的 Multica License；对第三方 hosted/embedded commercial use、品牌和 attribution 有额外条件，不等同于纯 Apache-2.0。
- Multica 也会采集并呈现各 CLI run 的 thinking/tool/text；RAH Room truth 不应重新走这条 transcript 统一路线。
- 若只为内部个人使用可以单独部署和连接，但复制 backend/UI 进入 RAH 会增加法律和升级耦合。

采用级别：**领域/安全模型借鉴**；可选外部 Issue connector，不嵌入其源码作为 RAH 核心。

### 9.6 Routa

来源：[phodal/routa](https://github.com/phodal/routa)

最有价值：

- workspace-first，而不是把目标、任务、trace、evidence 和 review 全埋在单一 chat。
- Web/Desktop 共用 API contract；拥有 board、session、trace、artifact、review、worktree。
- 同时探索 MCP、ACP、A2A、AG-UI/A2UI，和 RAH Agent OS 的协议分层接近。
- MIT 许可证适合源码研究和选择性移植。

RAH 应吸收：

- Workspace/Task/Session/Trace/Evidence/Review 的页面信息架构。
- board 作为协调总线、review/evidence 一等化。
- Web 与 Desktop 共享 API contract、而不是各自拥有行为。

风险：

- 产品范围很广且仍快速演进，不能直接替换 RAH 后假设 bug 自动消失。
- 与 RAH 的 Room/runtime/store 重叠很大；深 fork 会变成新的长期维护分支。

采用级别：**最重要的开源架构对照与选择性移植候选**；同时保留独立 bake-off，不直接宣布底座迁移。

### 9.7 AionUI / AionCore

来源：[iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi)

最有价值：

- Apache-2.0、跨平台、ACP Team、丰富的 PDF/Office/Markdown/image/HTML/diff 展示。
- ACP runtime/session/client factory、permission、prompt、translator 分层值得作为 RAH L2 实现参考。
- scheduled/automation、远程 WebUI 和多 agent Team 是 Room OS 可借鉴的大功能。

RAH 可借力：

- 优先复用官方 ACP SDK/adapter；必要时参考 AionUI 的 runtime 分层，不复制其整套 transcript store。
- 对独立 artifact viewer 做小模块技术评估，确认依赖和 attribution 后再决定移植。
- 借鉴 Team UI、automation 和 preview UX。

风险：

- provider `session/load` replay、稳定 identity 和外部 CLI 历史发现仍可能出现与 RAH 相同的问题。
- Team 模式如果共享同一目录而没有 worktree isolation，不适合并行写代码的默认安全边界。

采用级别：**ACP 与 artifact UI 参考/选择性移植候选**，不使用其 transcript projection 作为 Room truth。

## 10. 其它成熟项目和协议

### 10.1 Zed + ACP

来源：[Zed External Agents](https://github.com/zed-industries/zed/blob/main/docs/src/ai/external-agents.md)

Zed 已验证一种与本提案一致的边界：UI 持有 thread，External Agent 通常拥有自己的 runtime、auth、模型、工具和原生配置；不支持/不需要富 ACP 时可以使用 terminal-backed thread。它也支持从外部 agent 导入 thread，但这不意味着 RAH 必须把导入 transcript 变成 Room truth。

采用建议：

- ACP 是 RAH L2 的首选，不自创第二套 agent-client transport。
- provider 登录和订阅留在 external agent，不把全部 API key 收入 RAH。
- 通过 capability negotiation 暴露可用功能。
- Room bridge 仍独立存在；ACP 解决 UI↔agent turn，不替代多方协作 ledger。

采用级别：**直接集成官方 ACP SDK/registry/adapters**。

### 10.2 AG-UI

来源：[ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui)

AG-UI 提供 agent-user streaming、双向状态、structured/generative UI 和 frontend tools 的标准事件，且 transport 无关。

采用建议：

- 可作为外部 agent app 接入 RAH 的 UI/run connector。
- 可借其 event parts 和 generative UI 安全边界。
- 不直接替代 Room ledger：AG-UI 主要描述一次 agent-user execution，缺少 RAH 需要的长期多成员、Task、Decision、Review truth。

采用级别：**可选 connector / 协议参考**。

### 10.3 A2A

来源：[a2aproject/A2A](https://github.com/a2aproject/A2A)

A2A 面向不暴露内部 state/memory/tools 的 opaque remote agents，提供能力发现、长任务和多模态协作。它适合未来把远端专业 agent 服务作为 Room participant 接入。

采用建议：

- 本地 CLI 仍优先 Room bridge/ACP，不为了“标准化”套一层 A2A。
- 远端组织或第三方 agent 服务可通过 A2A gateway 映射为 participant/run/task。
- A2A task 状态需要映射到 RAH RunAttempt，不能成为第二个 task truth owner。

采用级别：**未来远端 agent gateway**。

### 10.4 Agent Kanban

来源：[graywrk/agent-kanban](https://github.com/graywrk/agent-kanban)

其“board 被动提供 MCP，agent 自己 get/claim/progress/review”的 pull 模式和 Room Task bridge 高度一致。项目规模和成熟度不足以直接成为 RAH 核心，但很适合做协议 corpus：验证不同 agent 是否能可靠 claim、progress、comment、artifact、review。

采用级别：**协议参考和互操作测试对象**。

### 10.5 OpenHands Agent Canvas

来源：[OpenHands architecture](https://github.com/OpenHands/OpenHands/blob/main/docs/architecture.md)

可借鉴：多 backend registry、conversation/terminal/browser/files/automation 前端、独立 agent server 和 sandbox 边界。OpenHands 通常拥有自己的 agent loop/runtime，因此不适合作为任意原生 CLI 的统一执行层。

采用级别：**sandbox、automation 和 Agent Canvas UX 参考**。

### 10.6 Kangentic 与 Vibe Kanban

来源：

- [Kangentic](https://github.com/Kangentic/kangentic)
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban)
- [Vibe Kanban sunset announcement](https://www.vibekanban.com/blog/shutdown)

Kangentic 的 board pipeline、worktree、diff、session persistence、handoff、usage/cost 是有价值的功能清单；但其 AGPL-3.0 和 native hook + PTY fallback 路线不适合直接成为 RAH 核心。Vibe Kanban 的 issue/workspace/review/browser UX 很成熟，但项目已经进入 community-maintained sunset，说明 star 数和专业团队不能替代数据出口、版本锁定和回滚方案。

采用级别：**UX/失败教训参考，不作为核心依赖**。

## 11. RAH OS 最值得优先增加的大功能

### P0：Room 与 bridge

- 单 agent Session 与 Council 统一为 Room。
- 真人/agent membership、mention、thread、inbox cursor。
- MCP/CLI room bridge 与严格 acknowledgement。
- RunAttempt 与原生 terminal inspector。

主要来源：Raft、当前 Council、Agent Kanban、Zed/ACP。

### P1：Task、Run、worktree、Review

- Issue/Task/Dependency/DispatchAttempt。
- worktree isolation、setup receipt、branch/base/head。
- decision gate、retry、timeout、cancel、worker_done。
- frozen diff、inline review、request changes、verifier。

主要来源：Orca、Multica、Routa、Vibe Kanban、Kangentic。

### P2：Artifact Center

- 图片、HTML、PDF、Office、Markdown、CSV、报告和测试证据统一 registry。
- thumbnail、preview、下载、source/run/task provenance。
- artifact search、pin、compare 和生命周期。

主要来源：AionUI、Orca、OpenHands Agent Canvas。

### P3：Remote Runner 与持续工作

- computer/runner registry、在线状态、版本、能力与资源。
- SSH/remote attach、断线重连、polling backstop。
- schedules、reminders、automation trigger。
- task-scoped credentials 与 sandbox profile。

主要来源：Herdr、Raft Computers、Orca SSH、Multica daemon、OpenHands automation。

### P4：质量、成本和能力路由

- 每个 RuntimeProfile 的成功率、返工率、审查有效率、时间和成本。
- provider/model/version 与任务类型关联。
- blind review 与异构 verifier 模板。
- 可解释的 runtime 推荐，不自动隐藏切换。

主要来源：Kangentic usage、Multica runtime activity、Orca run/dispatch provenance。

## 12. 推荐的采购与集成策略

| 能力 | 首选策略 | 不建议 |
| --- | --- | --- |
| 多方协作 ledger | RAH 自有，借鉴 Raft | 依赖闭源 hosted core |
| agent-client 富协议 | 官方 ACP SDK/adapter | 自创完整替代协议 |
| 任意 CLI | Generic PTY + Room CLI bridge | 为每家写 transcript parser |
| PTY runtime | 现有 RAH 与 Herdr sidecar 做 A/B spike | 双 PTY owner |
| worktree/orchestration | 自有领域模型，借 Orca receipt/CLI | 嵌整个 Electron 栈 |
| Issue/Run | 自有 store，借 Multica/Routa 模型 | 嵌入受限许可证 backend |
| artifact viewer | RAH 自有 registry，评估 Apache/MIT 小模块 | 从回复路径启发式扫描 |
| remote opaque agent | 后续 A2A gateway | 本地 CLI 全部强制 A2A |
| generative UI | 受限 AG-UI/A2UI connector | 允许 agent 注入任意主页面脚本 |

依赖原则：

1. 协议/CLI/socket 优先于源码 fork。
2. sidecar 优先于把另一个 runtime 塞进 daemon 进程。
3. 每个外部组件必须可关闭、可替换、可导出数据。
4. canonical Room/Task/Artifact 数据不写入只有上游产品才能读取的格式。
5. 固定版本并提供升级/回滚窗口；不对关键工作台自动追 latest。
6. 引入源码前记录 commit、许可证、NOTICE、修改范围和上游同步策略。

## 13. 渐进迁移路线

### Phase 0：冻结新增解析债务

- 新 provider 默认只允许 L0/L1/L2，不新增 transcript parser。
- 当前 provider-specific Conversation 继续维护稳定性，但不再扩成 Room truth。
- 为 Legacy Session/Run Inspector 标注现状所有权。

### Phase 1：Room Ledger v1

- 从 Council store 提取 provider-neutral Room/Membership/Message owner。
- 建立 Room cursor、idempotency、inbox、pull/wait/post。
- MCP 与 CLI facade 进入同一 service。
- current Council 先适配新 ledger，运行控制暂不重写。

### Phase 2：单 agent Room

- New Task 创建 Room + 一个 AgentParticipant + 一个 RunAttempt。
- 原 Session Chat 在 UI 上映射为单 agent Room。
- provider final 不再自动成为 Room message；agent bridge 显式 post result。
- 保留 provider transcript 作为 linked legacy inspector，验证用户体验与可追溯性。

### Phase 3：Task/Artifact/Review

- 新增 Task、Dependency、Decision、Artifact、Review store/API。
- worktree、frozen diff、review gate 与 verifier 建立 canonical owner。
- Changed Files 与 visual 逐步从 provider parser 迁移到显式 artifact publish。

### Phase 4：Runner abstraction

- 把现有 provider runtime 收敛为 Run owner 接口。
- 建立 GenericPtyRunner、AcpRunner 和可选 HerdrRunner spike。
- provider session ID 只作为 opaque ref。
- 只有明确价值的 L3 adapter 保留历史/resume增强。

### Phase 5：Remote 与生态 connector

- computer/runner registry。
- GitHub/Linear/外部 Issue connector。
- 可选 Raft、Orca、Multica connector。
- A2A remote agent 与 AG-UI app connector。

每个阶段都必须能独立交付和回滚，不能以“新 Room 尚未完成”为由破坏当前 Session 使用。

## 14. 验收与退出标准

### 14.1 Room 协议门禁

- 同一 client message 重试只产生一个 Room message。
- wake injected 不推进 pulled/acknowledged cursor。
- agent 忙碌、掉线、重启后 inbox 不丢、不重复消费。
- 真人和多个 agent 并发 post 后 Room cursor 确定。
- lifecycle/status telemetry 不触发 agent 互相无限唤醒。
- 无 MCP 的 CLI 能通过 CLI facade 完成 pull/post/task/artifact/review。

### 14.2 Run 门禁

- 每个 Run 只有一个 process/PTY owner。
- Room 切换、PWA reload、Canvas attach 不会 stop Run。
- provider session resume 失败时可创建新 Run + handoff，不污染 Room history。
- runtimeProfile/provider/model/auth source 在 Info 中可追溯。

### 14.3 Task/Review 门禁

- task completion 与 process exit、stdout 文案解耦。
- worktree 并行不互相覆盖。
- reviewer 使用 frozen diff 和 artifact，不读变化中的全局 Git 状态。
- blind review 能证明 reviewer 未继承 implementer 的结论。

### 14.4 删除旧 parser 的条件

只有满足以下条件才能删除对应 provider 的 Room-facing parser：

- 该 provider 的主要工作流已经通过 L1 bridge 或 L2 ACP 发布 Room message。
- artifact/review 已有显式发布通道。
- legacy session 仍可在 Run Inspector/原生 CLI 中查看。
- 至少一个稳定版本周期证明 Room history、resume/handoff 和 PWA 使用无数据损失。

## 15. 开放决策

以下事项在实现前仍需 ADR：

1. 协议内部最终命名使用 `Room` 还是 `Topic`；建议内部 Room、UI 主题。
2. Room event log 的物理存储采用 append-only JSONL + index，还是 SQLite WAL + append-only audit；语义必须先于存储实现确定。
3. Herdr 是否作为可选 PTY owner；需要隔离 spike 测量 attach、输入、scrollback、restore、Windows/macOS/Linux 和升级行为。
4. Agent identity 是否允许跨 Room 共享长期 memory；第一版建议只共享 profile/skills，不自动共享私密 Room 内容。
5. 外部项目源码移植的治理：建议逐模块 ADR、固定 upstream commit、NOTICE 和回归 corpus。
6. Room 与现有 Archive/Library 的迁移：建议保留 Legacy Session Library，Room Archive 单独建立，不混用物理删除语义。

## 16. 最终结论

RAH OS 不需要重新实现 Orca、Herdr、Raft、Multica、AionUI 和 Routa 的全部功能。最可持续的组合是：

- 用 RAH 自有 Room ledger 持有协作真相。
- 用 Raft 的 external-agent/聊天室模型约束消息与成员语义。
- 用 ACP/Zed 生态承接结构化 harness UI。
- 用 Generic PTY，并评估 Herdr sidecar 承担可持久运行现场。
- 用 Orca 的 Run/Task/Dispatch/Gate、worktree 和 review 经验强化执行编排。
- 用 Multica/Routa 的 Issue/Run/evidence 模型丰富任务操作系统。
- 用 AionUI/OpenHands 的 artifact/automation UX 丰富网页工作台。
- 用 A2A/AG-UI 作为未来 connector，而不是新的 canonical owner。

核心防线不变：任何外部项目都不能重新把 provider transcript、终端 screen 或 hosted product 变成 RAH Room 的唯一真相。
