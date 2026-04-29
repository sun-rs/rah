# RAH 项目总览

## 1. 项目定位

RAH 是一个 **runtime-owned、本地优先、跨设备连续性** 的 AI 工作台。

它的核心目标不是做一个“网页终端转播器”，也不是做一个只服务某一家 CLI 的前端壳，而是：

- 把不同 provider 的行为统一映射到一套稳定的事件契约
- 让 Web / 手机 / 平板 / 本地终端都围绕同一个 runtime 会话工作
- 让未来的 provider 变化尽量只影响 adapter，不影响协议和主界面

当前主线已经明确聚焦在四层：

- 契约层
- 约束层
- Codex reference adapter
- 多 provider 结构化工作台主线（Codex / Claude / Gemini / Kimi / OpenCode）

如果只需要阅读当前稳定设计，先看：

- [当前系统设计总览](./current-system-design.zh-CN.md)
- [历史浏览与分页边界](./history-browsing.zh-CN.md)
- [Session 入口与权限边界](./session-entry-capability-boundary.zh-CN.md)
- [Provider Adapter 协议与能力边界](./provider-adapter-protocol.zh-CN.md)

## 2. 设计理念

### 2.1 本地优先

RAH 假设真正的开发环境、代码和工具都在用户自己的机器上。

因此：

- runtime daemon 运行在本机
- provider 适配器运行在本机
- 前端只是连接 runtime 的客户端

### 2.2 runtime-owned continuity

RAH 的连续性优先依赖 runtime 自己拥有的会话，而不是依赖 provider 是否能完美 resume。

这意味着：

- live session 是第一优先级
- provider 的 rollout / transcript / session files 只能作为 fallback 或历史恢复来源
- rehydrated history 与 live controllable session 必须严格区分

### 2.3 协议先于界面

RAH 的设计顺序不是“先把 UI 做漂亮”，而是：

1. 定义 canonical event taxonomy
2. 定义 contract 和 sequence invariants
3. 用 Codex reference adapter 验证这些抽象不是空想
4. 让前端围绕 canonical feed 渲染

### 2.4 不越过 hapi / paseo 的成熟边界

RAH 明确把 hapi 和 paseo 当作成熟经验来源，而不是随意超设计。

因此：

- transcript / tool / permission / usage / attention 是核心工作台内容
- PTY 是辅助基础设施，不是主表达面
- provider 内部维护事件不应轻易升级成产品级新概念

## 3. 目标

RAH 的中长期目标可以概括为：

### 3.1 协议层目标

- 建立一套尽可能稳定、尽可能少改动的 canonical protocol
- 让未来 provider 漂移主要由 adapter 吸收
- 尽量避免因为接入新 provider 而修改前端主界面

### 3.2 runtime 层目标

- 让 session / control / event bus / PTY / provider adapter 都由 runtime 统一管理
- 对客户端暴露稳定的 HTTP / WS / PTY 协议
- 为跨设备控制与观察提供统一入口

### 3.3 产品层目标

- 提供结构化工作台，而不是原始终端镜像
- 让用户能看懂 agent 在做什么、当前需要什么、为什么失败、下一步怎么恢复
- 保持 UI 在风格上克制、在语义上强表达

## 4. 当前使用方法

### 4.1 安装依赖

```bash
npm install
```

### 4.2 启动统一前后台入口

```bash
npm run serve:workbench
```

然后打开：

```text
http://127.0.0.1:43111/
```

现在 `43111` 已经是统一入口。daemon 当前监听 `0.0.0.0`，所以同一局域网里的手机/平板也可以通过 Mac 的局域网 IP 访问，前提是防火墙和网络允许。

- 前端静态资源
- HTTP API
- WebSocket 事件流
- PTY 通道

都由 daemon 同源提供。

### 4.3 开发模式

如果要分离开发前后端：

```bash
npm run dev:daemon
npm run dev:web
```

此时：

- `43111` 是 daemon API / WS
- `43112` 是 Vite 开发前端

但这只是开发模式，不应作为正式跨设备访问入口。

### 4.4 核心命令

```bash
npm run build:web
npm run serve:workbench
npm run typecheck
npm run test:web
npm run test:runtime
```

### 4.5 测试分层

RAH 现在应当把测试分成三层理解：

#### 默认门禁

任何开发环境都应能跑：

- `npm run typecheck`
- `npm run test:web`
- `npm run test:runtime`

#### provider smoke

这些测试依赖真实 provider CLI 和对应账号环境：

- `npm run test:smoke:history-claim`
- `npm run test:smoke:tool-flow`
- `npm run test:smoke:gemini-flow`
- `npm run test:smoke:gemini-browser`
- `npm run test:smoke:kimi-flow`
- `npm run test:smoke:kimi-browser`
- `npm run test:smoke:claude-flow`
- `npm run test:smoke:claude-browser`

它们不应被粗暴视为“所有开发者本机默认必须通过”的检查。

RAH 不应定义一个“所有 provider smoke 在任何机器上都必须全部跑完”的统一命令。

原因很直接：

- 某台机器可能只装了部分 CLI
- 某个 provider 可能二进制可执行，但账号未登录
- 某个 provider 可能已登录，但当前账号没有额度或权限

所以 provider smoke 的正确策略是：

- 按 provider 单独运行
- 只在对应 CLI 和账号都已准备好的环境中运行
- 更适合作为专门 CI runner 或发布前专门机器上的条件门禁

#### 发布/CI 门禁

provider smoke 更适合在：

- 已经配置好 provider CLI
- 已经登录并具备账号权限
- 环境变量和工作目录都正确

的专门 runner 上执行。

RAH 不应把“本机装了 CLI”误当成“provider 必然可用”。

## 5. 架构设计

## 5.1 包结构

```text
packages/
  runtime-protocol/   协议、事件模型、契约校验
  runtime-daemon/     RuntimeEngine / EventBus / PtyHub / ProviderAdapter
  client-web/         Workbench UI
```

## 5.2 核心运行链路

### runtime-protocol

负责定义：

- session model
- event families
- canonical payload
- contract validator
- sequence invariants

这是整个项目最底层、最应该稳定的一层。

### runtime-daemon

负责：

- `RuntimeEngine`
- `SessionStore`
- `EventBus`
- `PtyHub`
- `ProviderAdapter` seam
- `CodexAdapter`
- `ClaudeAdapter`
- `GeminiAdapter`
- `KimiAdapter`
- `OpenCodeAdapter`
- `DebugAdapter`

这一层的职责是把 provider-native 行为翻译成 canonical runtime surface。

Provider 的 rename/delete/archive/info、权限 mode、plan mode、model list、reasoning/config 参数、permission response、历史解析和 workspace metadata recovery 都应通过 adapter 暴露。前端只提交 `modeId/model/reasoningId` 等 RAH 标准字段，不解释 provider-native 参数。

### client-web

负责：

- 通过同源接口连接 daemon
- 渲染 canonical `FeedEntry`
- 表达 session capability、permission、attention、observation、tool detail

前端不应该直接理解 provider-native 事件名。

## 5.3 事件分层

RAH 现在有明确的分层：

### Core workbench

- `session`
- `control`
- `turn`
- `timeline`
- `message_part`
- `tool_call`
- `observation`
- `permission`
- `usage`
- `attention`
- `terminal`

### Infrastructure

- `operation`
- `governance`
- `runtime`
- `notification`
- `host`
- `transport`
- `heartbeat`

这条边界已经在代码和文档里固定下来，不应该轻易扩张。

## 5.4 Provider Diagnostics

RAH 现在提供轻量 provider diagnostics，用于帮助用户理解：

- 这个 provider 的启动命令是什么
- 二进制是否存在
- `--version` 是否能成功

但 diagnostics **不判断账号认证是否可用**。  
认证、配额、账号权限仍由 provider CLI 自己负责。

这条边界是刻意保持克制的，和 hapi / paseo 的经验一致：

- availability 和 auth 不是一回事
- binary 存在，不代表一定能成功运行真实会话

## 6. 技术路线

RAH 当前已经形成了比较明确的推进路线。

### 第一阶段：契约层

完成 canonical taxonomy、event family、contract validator、boundary docs。

### 第二阶段：Codex reference adapter

用 Codex app-server live stream 和 stored rollout 两条线，证明 canonical protocol 足以表达真实 provider 行为。

### 第三阶段：前端 canonical feed

不再依赖 provider-specific 映射，而是直接消费 canonical `FeedEntry` 渲染。

### 第四阶段：同源交付

daemon 统一提供前端静态资源与 API/WS，消除双端口、baseUrl、局域网/Tailscale 易错链路。

### 第五阶段：冻结 v1 边界

不是继续加功能，而是判断：

- 哪些已经是稳定协议
- 哪些还只能算 adapter 内部策略
- 哪些仍属于 UI 文案/交互层，不应误认为协议稳定项

## 7. 已完成

当前已经完成的关键工作如下。

### 7.1 契约与文档

- canonical event taxonomy
- workbench boundary
- Codex event coverage
- protocol freeze status

### 7.2 契约校验器

`validateRahEventSequence` 已经具备：

- envelope 基础校验
- canonical payload 校验
- lifecycle 合法性校验
- `runtime.invalid_stream -> heuristic + raw` 约束
- tool / observation / permission 的 `turnId` 一致性约束

### 7.3 Codex reference adapter

Codex 现在已经是 reference adapter，而不是 demo：

- live app-server stream
- stored rollout replay
- live resume
- fallback rehydrate
- permission / question round-trip
- MCP elicitation
- PTY output bridging

### 7.4 前端主线

前端已经回到 canonical feed 主线：

- 直接消费 `FeedEntry`
- 渲染 timeline / tool / observation / permission / attention / operation / message part
- 不再依赖旧的简化聊天映射层

### 7.5 同源交付

`43111` 已经成为统一工作台入口。

这意味着：

- 局域网/Tailscale 使用更稳定
- 前后端版本更一致
- 访问路径更接近正式产品，而不是开发服务器暴露

### 7.6 Codex 能力边界表达

现有能力位已经被拉直到真实行为：

- live Codex session 可输入、可 live permission
- rehydrated Codex session 明确只读
- UI 已显式显示 `interactive / observe-only / read-only replay`

### 7.7 多 provider 主线

当前已经打通并通过真实链路验证的 provider：

- Codex
- Claude
- Gemini
- Kimi
- OpenCode

这里的“打通”不是指能连上就算，而是至少覆盖：

- new session
- history replay
- claim / live upgrade
- 工具调用或文件读写
- close 后 recent / stored 恢复

## 8. 未完成

当前还没有完成的部分同样需要明确。

### 8.1 v1 冻结决策尚未完全锁死

虽然已经有 `protocol-freeze-status.md`，但还没有形成最终发布级“冻结决定”。

### 8.2 client-web store ownership 已基本收口

这条线现在已经不再是主要结构债。

`packages/client-web` 当前已经把 ownership 明确分到：

- bootstrap
- sync / transport
- projections
- workspace
- history
- history bootstrap / paging / selection sync
- session lifecycle / commands / startup

`useSessionStore.ts` 现在更接近 orchestration shell，而不是继续承载整团混合逻辑。

剩余工作主要是：

- 少量 local wrapper / deps bridge 的继续压缩
- 持续防止新逻辑回流进 `useSessionStore.ts`

详细边界见：

- [client-web-store-ownership.zh-CN.md](./client-web-store-ownership.zh-CN.md)

### 8.3 浏览器级自动化回归还没成为正式门禁

当前核心测试强在：

- contract
- runtime
- Codex fixtures

但这些 smoke 还没有完全升成发布/CI 的标准门禁。

### 8.4 Codex PTY 双向接管未实现

当前 RAH 的 1.0 边界仍然是：

- 结构化 transcript / tool / permission / history / claim / live upgrade

而不是：

- Codex PTY 主机级双向接管

这件事如果要做，应被视为独立能力线，而不是当前 1.0 的必备组成。

### 8.5 远程访问安全模型未收紧

当前更偏开发/个人设备场景：

- 同源入口已经稳定
- 但对外暴露的安全和认证边界还没进入正式产品级阶段

## 9. 1.0 边界与下一步

### 9.1 现在是否可以视为 1.0

现在更准确的判断是：

- **契约层：1.0**
- **多 provider 结构化工作台：1.0**

如果把 1.0 定义为：

- canonical events 稳定
- Codex / Claude / Gemini / Kimi / OpenCode 主线打通
- history / replay / claim / live upgrade 成立
- UI 不再暴露 provider 内部噪声

那么 RAH 现在已经可以视为正式 1.0。

但如果把 1.0 定义成：

- 所有 provider auth 都能预先可靠判断
- Codex PTY 双向接管已经完成
- 任何机器上只要装了 CLI 就能稳定 smoke

那这个目标本身就不合理，也不是 hapi / paseo 现在真正承诺的边界。

### 9.2 下一步

如果继续沿主线推进，最合理的下一步不是继续做新 UI，而是：

### 9.2.1 锁 v1 freeze decision

把当前已经形成的 freeze candidate 明确写成“默认不改”的协议决策。

### 9.2.2 把 smoke 更明确接入发布/CI 门禁

默认门禁和 provider smoke 的分层已经明确，但还应继续工程化：

- 默认门禁保持环境无关
- provider smoke 在专门环境执行
- 文档和 CI 规则保持一致

### 9.2.3 继续补新的 provider adapter

现在已经不是“先别补 provider”的阶段，而是：

- 可以继续补新的真实 provider adapter
- 同时继续收尾 store ownership 和门禁化

重点不是视觉，而是验证这些产品状态：

- no control
- read-only replay
- permission unavailable
- connection issue
- live resume / fallback rehydrate

## 10. 设计判断

从当前阶段来看，RAH 现在最强的不是视觉层，而是：

- 契约层已经越来越接近可冻结
- Codex 参考适配线已经能证明抽象不是空想
- 前端现在主要是消费 canonical feed，而不是反向定义协议

这说明项目已经从“探索期”进入“收敛期”。

现在最重要的不是继续长更多功能，而是控制变量，把底层边界锁住。

## 11. 阅读顺序建议

如果要按正确顺序理解当前项目，建议这样读：

1. [README](../README.md)
2. [RAH Workbench Boundary](./workbench-boundary.md)
3. [RAH Canonical Event Taxonomy](./canonical-event-taxonomy.md)
4. [Codex Adapter Event Coverage](./codex-event-coverage.md)
5. [Provider Adapter Maintenance](./provider-adapter-maintenance.md)
6. [架构对照与强化路线](./architecture-benchmark.zh-CN.md)
7. [Protocol Freeze Status](./protocol-freeze-status.md)
8. [Release Checklist](./release-checklist.md)

如果要动代码：

1. 先看 `packages/runtime-protocol`
2. 再看 `packages/runtime-daemon`
3. 最后看 `packages/client-web`

不要反过来从 UI 推导协议。协议应由契约和 reference adapter 决定。
