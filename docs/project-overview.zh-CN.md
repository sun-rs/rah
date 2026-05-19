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
- provider-native runtime 工作台主线（Codex / Claude / OpenCode）

当前 runtime 边界不是“一切 PTY-first”：

- Codex 使用 `native_local_server`，以官方 app-server 的结构化事件和控制协议作为 live source of truth；RAH 预创建 thread，再让官方 TUI remote client attach 到同一 thread。
- OpenCode 使用 `native_local_server`，以官方 serve/session API 作为 live source of truth；官方 TUI attach 到同一 provider session。
- Claude 保留 `tui_mux` / `tui_mux_fallback`，因为 Claude Code 当前没有稳定公开的 Codex/OpenCode 等价本地 app-server。

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
node bin/rah.mjs restart --no-open
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

日常代码更新后也使用 `restart`。它会重新 build Web、停止当前 managed daemon，并从当前 checkout 拉起新的 `43111`。

如果只是后端改动，不需要重建 Web bundle：

```bash
node bin/rah.mjs restart --no-build --no-open
```

`npm run serve:workbench` 仍可用于开发，但不是普通用户层面的推荐入口。

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
- `npm run test:smoke:claude-flow`
- `npm run test:smoke:claude-browser`
- `npm run test:smoke:opencode-browser`

它们不应被粗暴视为“所有开发者本机默认必须通过”的检查。

当前 live smoke 主矩阵覆盖 Codex、Claude、Gemini、OpenCode 的公共入口；Gemini 真实长流程仍以 `tui_mux` 人工 QA 为主。Kimi CLI 一等支持已移除；相关模型通过 OpenCode/API provider 验证。

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
- identity-only `ProviderAdapter` seam + explicit capability slices/maps
- Codex / Claude / Gemini / OpenCode native TUI launch、binding、mirror handler
- Codex / Claude / Gemini / OpenCode stored-history adapter
- `DebugAdapter`

这一层的职责是把 provider-native 行为翻译成 canonical runtime surface。当前 live 主矩阵为
Codex、Claude、Gemini、OpenCode；Kimi CLI 一等支持仍移除，相关模型通过 OpenCode/API provider 承载。

Provider 的 rename/delete/archive/info、权限 mode、plan mode、model list、model option/config 参数、permission response、历史解析和 workspace metadata recovery 都应通过显式 capability slice 暴露，而不是塞回一个大号 `ProviderAdapter`。前端只提交 `modeId/model/optionValues` 等 RAH 标准字段，不解释 provider-native 参数；旧 `reasoningId` 只是兼容别名。

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

当前已经打通并通过真实链路验证的 core live provider：

- Codex
- Claude
- OpenCode

这里的“打通”不是指能连上就算，而是至少覆盖：

- new session
- history replay
- claim / live upgrade
- 工具调用或文件读写
- close 后 recent / stored 恢复

## 8. 当前 1.0 边界

RAH 当前 `main` 可以按 1.0 RC 的边界维护：

- canonical event / timeline / history paging 是稳定主线。
- Codex、Claude、Gemini、OpenCode 是一等 live provider。
- Codex/OpenCode 走 provider native local server；Claude/Gemini 走 tmux/TUI fallback。
- Kimi/Grok/DeepSeek/GLM/MiniMax 等低频模型通过 OpenCode/API provider 承载。
- Debug/fake provider 只服务测试和 UI exercise，不是产品 provider。

不承诺的内容也必须清楚：

- 不替 provider TUI 复刻所有 `/command` 和私有菜单。
- 不用 ANSI/TUI screen 反推 structured Chat。
- 不保证任意机器只要安装 CLI 就能通过真实 provider smoke；真实 smoke 依赖账号、额度、网络和 provider 版本。
- 不提供对外公网级认证模型；当前定位仍是本机/局域网个人工作台。

## 9. 下一步维护重点

- 保持 `ProviderAdapter` identity-only，新增行为必须走显式 capability slice。
- 新增 provider 或新能力时优先补 provider-specific translator/test，避免修改前端公共逻辑。
- 默认门禁保持环境无关；真实 provider/browser/PWA 测试作为发布前专门 gate。
- 继续压缩旧命名和旧测试入口，防止为了让过期测试通过而回滚正确产品边界。

## 10. 阅读顺序建议

如果要按正确顺序理解当前项目，建议这样读：

1. [README](../README.md)
2. [RAH Workbench Boundary](./workbench-boundary.md)
3. [RAH Canonical Event Taxonomy](./canonical-event-taxonomy.md)
4. [Codex Adapter Event Coverage](./codex-event-coverage.md)
5. [Provider Adapter Maintenance](./provider-adapter-maintenance.md)
6. [架构对照与强化路线](./architecture-benchmark.zh-CN.md)
7. [Release Checklist](./release-checklist.md)

如果要动代码：

1. 先看 `packages/runtime-protocol`
2. 再看 `packages/runtime-daemon`
3. 最后看 `packages/client-web`

不要反过来从 UI 推导协议。协议应由契约和 reference adapter 决定。
