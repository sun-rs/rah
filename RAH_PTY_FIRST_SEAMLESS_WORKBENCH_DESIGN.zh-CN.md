# RAH PTY-First Seamless Workbench Design

目标：在 `refactor/pty-first-core` 上把 RAH 重构为 PTY-first seamless workbench，并显著降低 live session 主链路复杂度。

## 核心定位

RAH 的 live truth 只能是后端持有的真实 PTY/TUI session。Web、PWA、桌面 terminal、canvas 都只是 attach 到同一个 session 的客户端。

结构化 WebUI 的唯一语义来源是各 provider 原厂 jsonl/db/session history 文件，不允许把 ANSI/TUI 输出反编译成 chat 作为主路径。

## Provider 分层

- Core live：`codex` / `claude` / `opencode`。
- Removed first-class CLI providers：`gemini` / `kimi`，不再保留 live、history-only 或 diagnostics 代码。
- 低频 Gemini/Kimi/Grok/DeepSeek/GLM/MiniMax 等 API-key 模型通过 OpenCode 承载。

## 关键等价关系

1. `rah codex` / `rah claude` / `rah opencode` 必须等价于 Web UI 里 New Session 后 attach 到同一个 PTY runtime。
2. `rah <provider> resume <providerSessionId>` 必须等价于 Web UI 里 Claim History 后用 resume launch spec 创建同一个类型的 PTY session。
3. Canvas pane、Web session page、PWA、桌面 terminal 都只是同一个 PTY session 的不同 client view。
4. 任何 client detach、close、browser reload、PWA background 不应杀死真实 TUI session，除非用户明确 close/archive/kill。
5. 底层必须收敛成：`NativeTuiLaunchSpec -> PTY Session Runtime -> attach clients -> mirror parser`。

## 必须遵守

1. 优先阅读并执行根目录 `RAH_PTY_FIRST_SEAMLESS_WORKBENCH_PLAN.zh-CN.md`。
2. 不再扩大“统一五家 CLI 的完整 Web 控制台”目标。
3. 模型选择、权限、effort、plan、slash command 等统一控件全部降级为 optional enhancement，不能阻塞 core。
4. Provider adapter 主责收敛为 launch spec、binding probe、mirror parser、minimal PTY control。
5. TUI view 必须原样显示 PTY，作为实时可信现场。
6. Chat/mirror view 必须来自原厂 jsonl/db/session 文件，mirror 失败不能影响 TUI session。
7. Web chat composer 只是向 PTY 注入文本的辅助入口，不能成为 provider 私有 live request 主路径。
8. Stop 主要是 PTY interrupt/control bytes，不再依赖 provider 私有 active-turn 状态机作为核心。
9. 所有重构必须保持可回滚、小步提交、每步有测试或明确验证。
10. 不要重新实现 provider 私有 live RPC，除非是保留兼容路径且不会影响 PTY-first 主链路。
11. 如果旧 structured live 主路径与 PTY-first 主路径冲突，应优先保留 PTY-first，并把 structured live 降级为兼容/实验/增强路径。
12. 避免形成 structured live + native TUI + wrapper handoff 三套并行系统；目标是 live session 主链路只有一个 PTY Session Runtime。

## Phase 0：冻结边界与代码盘点

- 审查现有 native TUI 代码与 `RAH_PTY_FIRST_SEAMLESS_WORKBENCH_PLAN.zh-CN.md` 是否一致。
- 标记代码为 core / mirror / enhancement / legacy structured 四类。
- 找出当前 Web new、Web claim、`rah xxx`、`rah xxx resume` 是否仍存在重复生命周期逻辑。
- 输出 audit：哪些模块应保留，哪些应合并，哪些应降级。
- 不急着删除功能，先明确边界和迁移顺序。

## Phase 1：PTY Session Runtime 统一化

- 抽出或收敛唯一 PTY Session Runtime，统一 create / attach / detach / control / replay / resize / interrupt / close。
- 让 Web-owned native TUI 和 `rah xxx` terminal attach 尽量共享同一个 runtime contract。
- `rah xxx` 不应是特殊 live session 类型；它应只是 create/resume PTY session + attach desktop terminal client。
- Web New Session 不应是另一套 live session 类型；它应只是 create PTY session + attach Web client。
- Web Claim History 与 `rah xxx resume` 都应走同一种 resume launch spec。
- 保持 PtyHub seq replay、control lease、resize、interrupt 可测试。

## Phase 2：Session Lifecycle 等价化

统一这些入口的底层行为：

- `rah <provider>`
- Web New Session
- Canvas New Session
- `rah <provider> resume <id>`
- Web Claim History
- PWA attach
- Canvas attach live

明确 session 状态机：created / running / attached clients / detached / exited / archived。

client detach 不等于 session close。archive/close/kill 必须是显式动作。页面刷新、PWA background、terminal 断开只能触发 detach/reconnect，不触发 resume。

## Phase 3：Mirror Layer 独立化

- 把 provider mirror parser 与 PTY runtime 解耦。
- Codex/Claude/OpenCode 各自负责 core live mirror：读取原厂 history/jsonl/db 并输出 provider activity。
- Gemini/Kimi CLI mirror 不再保留；如果需要这些模型，走 OpenCode/API provider。
- 统一 canonical identity，确保重复加载、live 后 backfill、history paging 都不重复显示。
- mirror missing/failed 只进入 diagnostics，不影响 PTY/TUI。
- 禁止把 ANSI screen scrape 作为 structured chat 的主路径。

## Phase 4：Client Attach Experience

- 统一 Web terminal、PWA terminal、canvas pane terminal、desktop terminal attach 的 replay/input 行为。
- 优化 iOS/PWA input bridge、visual viewport resize、快捷键 overlay、中文字体、行高、字宽。
- Chat/TUI 切换不得重建或污染 PTY session。
- 多客户端输入必须有 control lease，避免两个客户端同时写入同一个 TUI prompt。

## Phase 5：Workbench Shell

- Sessions / History / Recent / Workspaces / Canvas 只操作 view 和 attach，不隐式 resume/close live session。
- History 浏览不触发 claim/resume。
- Claim control 前才检查 cwd，不影响只读历史浏览。
- Canvas pane 切换、清空、hide 不应杀 live session。
- 同一个 live PTY session 可以被多个 view 观看，但输入权必须唯一。

## Phase 6：Enhanced Controls 降级

- 把模型、权限、effort、plan 从 core 正确性中移出。
- UI 明确 provider-specific capability，不承诺跨 provider 语义完全一致。
- enhanced control 失败不能影响 PTY live session。
- 官方 TUI 中能完成的能力优先通过 TUI 原生使用。
- 如果某 provider 新增 `/goal`、权限菜单、模型菜单等，RAH 不需要立即适配，用户可直接切到 TUI 使用。

## 验收标准

1. Codex、Claude、OpenCode 三家 core live provider 都能由 RAH PTY host 启动真实 TUI。
2. `rah <provider>`、Web New Session、Canvas New Session 底层都走同一个 PTY Session Runtime。
3. `rah <provider> resume <id>` 和 Web Claim History 底层都走同一个 resume launch spec + PTY Session Runtime。
4. Web/PWA/desktop terminal 能 attach/detach 同一个 session。
5. 客户端断开、刷新、切后台不杀 session。
6. replay 能让重新 attach 的客户端追上当前 TUI。
7. Chat mirror 来自原厂 jsonl/db/session 文件，不来自 ANSI screen scrape。
8. Mirror 失败不影响 TUI。
9. 连续输入、Stop、resize、control lease 不丢、不串、不重复。
10. browser smoke、runtime tests、typecheck、diff check 必须持续可跑。
11. iPad/Safari 真机项不能用自动测试假装完成，必须保留人工 QA 清单。
12. Gemini/Kimi CLI 代码不应在 runtime/client/scripts 中继续残留；移除原因只保留在文档中。
13. 代码复杂度应实际下降：provider live adapter 不再承担 provider 私有 RPC 主链路；Web/CLI session lifecycle 不再各自维护一套重复路径。
14. 每次认为完成一个阶段前，做 prompt-to-artifact audit：把阶段目标逐条映射到代码、测试、文档、命令输出证据；不确定就不能标记完成。

## 当前准备状态

- 当前分支应为 `refactor/pty-first-core`。
- 该分支从 `refactor/native-tui-backed-sessions` 的提交 `81b32b9` 派生。
- 旧分支快照已提交：`81b32b9 Add native TUI backed session MVP`。
- 根目录已有 `RAH_PTY_FIRST_SEAMLESS_WORKBENCH_PLAN.zh-CN.md`，后续以它作为最高项目边界文件。

## 最终目标

RAH 的 live session 主链路只有一个：PTY Session Runtime。

所有入口只是不同 client / different launch spec。结构化 WebUI 是原厂 session 文件的 mirror。官方 TUI 永远是用户可依赖的实时现场。
