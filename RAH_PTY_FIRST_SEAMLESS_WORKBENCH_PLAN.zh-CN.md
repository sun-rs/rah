# RAH PTY-First Seamless Workbench 重构计划

状态：设计边界文件。

建议目标分支：`refactor/pty-first-core`

本文用于重新定义 RAH 的长期主线。它不是继续扩大“统一五家 CLI 的完整 Web 控制台”，而是把 RAH 收敛成一个更稳、更独特的产品：

> RAH = 原生 AI CLI 的跨设备连续工作台。
>
> RAH 后端持有真实 PTY/TUI session；桌面 Terminal、Web UI、PWA/iPad/iPhone 都只是 attach 到同一个 live session 的客户端。结构化 WebUI 来自原厂本地 session 历史文件，而不是反编译终端画面。

## 1. 核心杀手功能

RAH 只把两件事作为核心正确性目标。

### 1.1 PTY 是 live truth

真实 provider CLI 运行在 RAH 后端持有的 PTY 中。

```text
codex / claude / gemini / kimi / opencode TUI
    <-> PTY
    <-> RAH PTY host
    <-> desktop terminal / web terminal / PWA / iPad
```

这意味着：

- 浏览器刷新不应中断 session。
- PWA 切后台再回来不应中断 session。
- 桌面 terminal 关闭只应 detach，不应杀掉 session。
- 多个客户端可以观看同一个 TUI，但输入必须有控制权仲裁。
- Stop 本质上是向 PTY 发送 provider TUI 能理解的 interrupt/control bytes，而不是复刻 provider 内部 RPC。

### 1.2 原厂 session 文件是 structured truth

结构化 WebUI 不应从 ANSI/TUI 屏幕输出反推语义。

结构化 Chat/Timeline 应来自各 provider 的原生历史文件、DB 或 wire log：

| Provider | Structured source |
|---|---|
| Codex | rollout JSONL / sessions |
| Claude | `.claude/projects/*.jsonl` |
| Gemini | conversation JSON / JSONL |
| Kimi | `wire.jsonl` / session files |
| OpenCode | `opencode.db` / official API-backed records |

这意味着：

- TUI view 是实时现场，永远可信。
- Chat view 是友好阅读层，best-effort，但应尽量准确。
- Mirror 失败只影响结构化展示，不能影响 TUI session。
- 不能把 terminal ANSI screen-scraping 作为结构化主路径。

## 2. 非目标

以下能力可以存在，但不能成为核心正确性目标。

| 能力 | 定位 |
|---|---|
| 统一模型选择 | 增强层；优先启动参数，避免热切 provider 私有协议 |
| 统一权限控制 | 增强层；官方 TUI 权限菜单才是最终真实能力 |
| 统一 reasoning/effort/options | 增强层；只在 provider 稳定暴露时支持 |
| 统一 plan/goal/slash command | 非核心；新 provider 功能优先让用户切到 TUI 原生使用 |
| 完整复刻 provider live RPC | 非目标；这是维护黑洞 |
| 从 ANSI 输出反编译 chat bubbles | 非目标；只允许作为临时 debug/diagnostic |
| RAH 自己创建 session DB 取代原厂历史 | 非目标；RAH 尊重原厂 session 文件和目录结构 |

## 3. 系统边界

### 3.1 Core PTY Host

职责：

- 创建 PTY。
- 在 PTY 内启动真实 provider TUI。
- 持有 provider 进程生命周期。
- 维护 output seq/replay buffer。
- 接收输入、resize、interrupt。
- 管理多客户端 attach/detach。
- 管理 control lease，避免多个客户端同时输入。

不负责：

- 理解 provider 模型参数语义。
- 解析 markdown。
- 做 provider 私有协议请求。

### 3.2 Client Attach Layer

客户端包括：

- `rah codex` / `rah claude` 等桌面 terminal wrapper。
- Web terminal。
- PWA/iOS/iPad terminal。
- Canvas pane terminal。

职责：

- 渲染 PTY bytes。
- 发送输入 bytes。
- 上报 resize。
- 显示当前 control lease 状态。
- 在断线后用 `fromSeq` replay 恢复。

### 3.3 Structured Mirror Layer

职责：

- 发现 providerSessionId。
- 发现对应原厂 history 文件/DB。
- 增量读取历史记录。
- 转换为 RAH timeline。
- 使用 canonical identity 去重。
- 为 WebUI 提供 user/assistant/tool/reasoning/usage 等友好展示。

不负责：

- 影响真实 TUI 状态。
- 阻塞用户输入。
- 将 mirror 状态作为唯一 live 状态。

### 3.4 Workbench Shell

职责：

- Workspace/session 索引。
- Live/History/Recent 管理。
- 多 session 分屏。
- Search/filter/sort。
- Archive/delete/rename 能力。
- Settings/diagnostics。
- PWA/tunnel/remote access。

原则：

- Workbench shell 可以增强体验，但不能让增强功能破坏 PTY live session。

## 4. Provider Adapter 的新职责

Provider adapter 应收敛成四类能力。

### 4.1 Launch Spec

给定 provider、cwd、resume target、可选启动参数，生成真实 CLI 命令：

```ts
type NativeTuiLaunchSpec = {
  provider: ProviderKind;
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  providerSessionId?: string;
};
```

### 4.2 Binding Probe

把 RAH session 绑定到原厂 providerSessionId。

来源可以是：

- TUI 输出中的 session id。
- 启动前生成并传入的 session id。
- 原厂 history 文件/DB 的新记录。
- provider-specific resume id。

### 4.3 Mirror Parser

读取原厂 session 文件/DB，输出 provider activity：

```ts
type MirrorUpdate = {
  status: "ok" | "missing" | "failed" | "unsupported";
  items: ProviderActivityEnvelope[];
};
```

### 4.4 Minimal Control

只保留跨 provider 稳定控制：

- raw input。
- Enter。
- Ctrl-C / interrupt。
- resize。
- close/archive。

模型、权限、plan、effort 等能力只能作为 optional enhancement，不能进入核心正确性闭环。

## 5. 事实源规则

### 5.1 live 事实源

唯一 live truth：

```text
PTY/TUI process state + PTY output
```

### 5.2 structured 事实源

唯一 structured truth：

```text
provider native history file / DB / wire log
```

### 5.3 RAH 自己的数据

RAH 可以持久化：

- workspace/sidebar 偏好。
- local title override。
- view/layout/canvas 状态。
- diagnostics。
- last selected provider/model/mode preference。

RAH 不应把这些持久化数据伪装成 provider 原生事实。

## 6. UX 原则

每个 live session 至少有 TUI view。

如果 mirror 可用，可以显示：

```text
Chat | TUI
```

如果 mirror 不可用，只显示 TUI，并给出轻量提示：

```text
Structured view unavailable. TUI session is still live.
```

输入规则：

- 默认输入进入 TUI/PTY。
- Chat composer 只是对 PTY 的文本注入桥。
- 如果 TUI prompt dirty，应阻止 Chat composer 注入，避免把用户在 TUI 里正在编辑的草稿污染掉。
- 多客户端输入必须先 claim control。

移动端规则：

- iOS/PWA terminal 输入桥是核心体验，不是附属功能。
- 快捷键辅助栏应作为 overlay，不应写入 ANSI 流。
- 键盘弹出时应按 visual viewport 重算 terminal 可见高度。
- 终端字体、字宽、行高应优先保证可读和 TUI 布局稳定。

## 7. 分阶段计划

### Phase 0：冻结边界

目标：

- 新建 `refactor/pty-first-core` 分支。
- 保留当前 native TUI 分支作为参考。
- 写入本文件作为产品/架构边界。
- 明确 enhanced controls 不再阻塞核心验收。

验收：

- 根目录有 PTY-first 计划文件。
- README 或 native TUI 计划引用本边界。
- 所有后续 issue/test 都按 core/mirror/enhancement 分类。

### Phase 1：PTY Core 瘦身

目标：

- 抽出 PTY session runtime，减少 provider-specific 逻辑污染。
- 明确 session lifecycle：create/attach/detach/control/replay/resize/interrupt/close。
- 统一 `rah xxx` terminal wrapper 与 Web/PWA attach 到同一 PTY runtime。

验收：

- 五家 provider fake/native smoke 可启动 TUI。
- Web reload 后可 replay。
- `rah xxx` terminal detach 不杀 session。
- Web/PWA attach 同一个 session 不触发 resume。

### Phase 2：Mirror Layer 独立化

目标：

- mirror parser 从 PTY runtime 中进一步解耦。
- 每家 provider 独立 parser，只输出 provider activity。
- 统一 canonical identity 与 history snapshot 去重。
- mirror failure 只进入 diagnostics。

验收：

- Codex/Claude/Gemini/Kimi/OpenCode 的 history parser 独立测试。
- 同一条 user/assistant/tool 不因 live/history 双通道重复。
- mirror 文件缺失时 TUI 不受影响。

### Phase 3：Client Experience

目标：

- Web terminal、PWA terminal、canvas terminal 的 attach/replay/input 行为统一。
- iOS 输入桥、快捷键栏、visual viewport resize 做成核心测试项。
- Chat/TUI 切换稳定，不重建 PTY session。

验收：

- Chromium/WebKit browser smoke。
- iPad/Safari 人类 QA 清单。
- terminal 中文宽度、输入法、旋转、后台恢复有明确人工测试。

### Phase 4：Workbench Shell

目标：

- Sessions/History/Recent/Workspaces 管理稳定。
- Canvas 分屏只操作 view，不关闭 live session。
- Search/filter/sort 不依赖 RAH 自建 session DB。

验收：

- live session 从 sidebar、sessions dialog、canvas pane 进入都只是 attach。
- history 浏览不触发 claim/resume。
- claim control 前检查 cwd，但不影响只读浏览。

### Phase 5：Enhanced Controls 降级

目标：

- 模型、权限、plan、effort 从核心协议降级为 provider enhancement。
- UI 显示 provider-specific capability，不承诺跨 provider 语义完全一致。
- 官方 TUI 内可完成的能力不再由 RAH 强行复刻。

验收：

- enhanced control 失败不会影响 PTY session。
- 真实 TUI 仍可使用官方 slash command / permission / goal。
- 文档明确哪些 provider 支持哪些 enhancement。

## 8. 成功标准

RAH 进入新主线封板时，应满足：

1. 五家 provider 都能由 RAH PTY host 启动真实 TUI。
2. 桌面 terminal、Web、PWA 都能 attach/detach 同一个 session。
3. 客户端断开不会杀 session。
4. Web/PWA reload 后可通过 replay 追上当前 TUI。
5. Chat mirror 来自原厂 history/jsonl/db，而不是 ANSI screen scrape。
6. Mirror 失败不影响 TUI。
7. 连续输入、Stop、resize、control lease 不丢、不串、不重复。
8. iPad/Safari 有人工 QA 通过记录。
9. 文档明确 enhanced controls 是 optional，不是 core。

## 9. 与 OpenChamber 的关系

OpenChamber 值得借鉴：

- PWA/iOS 处理。
- event stream reconnect/replay。
- runtime API 分层。
- terminal mobile input bridge。
- tunnel/QR/onboarding。

但 RAH 不应直接把 OpenChamber 的 OpenCode server 模型照搬为唯一后端，因为 RAH 的核心差异化是：

- 支持多家官方 CLI。
- 支持订阅账号驱动的官方 TUI。
- 尊重各 provider 原生 session 文件。
- 让 provider 新功能直接通过 TUI 可用，而不是等待 RAH 适配。

所以本计划采用的是：

```text
学习 OpenChamber 的 PWA/terminal/sync 工程规律
保留 RAH 的多官方 CLI PTY-first 定位
```

## 10. 一句话边界

> RAH 的核心不是替五家 CLI 重写一个 Web agent。
>
> RAH 的核心是让五家官方 CLI 的真实 TUI session 变成可跨设备 attach、可长期保持、可友好阅读、可多窗口管理的连续工作台。
