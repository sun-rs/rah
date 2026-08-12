# Session Library 与 Archive 重构方案

状态：实施中

目标版本：RAH 1.x 兼容迁移

适用 provider：Codex、Claude Code local、OpenCode

## 1. 决策

RAH 采用 Codex 风格的会话库模型：用户添加一个工作区后，该工作区下所有未归档的根 Session 都属于左侧工作区列表，不再以 runtime 是否仍在运行决定其可见性。

Archive 是可恢复的会话库位置，不是 runtime 生命周期。RAH 保留两个正交状态轴：

```text
runtimeState: running | stopped
libraryPlacement: workspace | archive
```

稳定组合只有：

| runtime | placement | 含义 |
| --- | --- | --- |
| running | workspace | 正在由 RAH 管理的会话 |
| stopped | workspace | 可直接打开、首次发送时隐式 Resume 的普通历史会话 |
| stopped | archive | 只读归档，可浏览、恢复或删除 |

`running + archive` 不是稳定状态。归档 running Session 必须由 daemon 串行执行 Stop 与 Archive。

## 2. 用户可见行为

### 2.1 左侧工作区

- 每个已添加工作区显示所有 `libraryPlacement=workspace` 的根 Session。
- Running Session 显示 `starting/working/approval/ready` 等运行状态。
- Stopped Session 保留在原工作区，使用安静的静态样式，不伪装为 Ready。
- Session 行在 hover/focus 时提供 Archive 动作。
- Side、临时 agent 和 ephemeral branch 不进入根 Session 列表。
- 逻辑上不截断会话；大量条目通过虚拟列表或分段渲染控制 DOM 数量。

### 2.2 Chats

Chats 提供四个入口：

- `Recent`：最近 running/stopped 普通 Session。
- `All`：所有未归档 Session，按工作区分组。
- `Archived`：所有归档 Session，按工作区分组。
- `Council`：Council 历史，保持独立语义。

Archived 支持：

- 只读打开；
- Restore；
- 单条 Delete；
- 对当前筛选结果按工作区批量 Delete；
- 全部 Delete，必须二次确认并显示 provider/数量摘要。

Restore 只把 Session 放回普通会话库，不自动创建 runtime。用户下一次发送时仍走隐式 Resume。

### 2.3 删除

- Archive 是默认整理动作，必须可恢复。
- Delete 是破坏性动作，默认只在 Archived 中突出展示。
- UI 必须按 adapter 的真实结果区分 `Move to Trash` 与 `Delete permanently`。
- Stop、Archive、Delete 三个动作不得共享同一个状态或文案。

## 3. 协议模型

`StoredSessionRef` 新增 RAH-owned `libraryState`：

```ts
type StoredSessionLibraryPlacement = "workspace" | "archive";
type StoredSessionArchiveBackend =
  | "provider_native"
  | "rah_overlay"
  | "rah_snapshot";

interface StoredSessionLibraryState {
  placement: StoredSessionLibraryPlacement;
  archivedAt?: string;
  backend?: StoredSessionArchiveBackend;
}

type StoredSessionRemovalDisposition = "trash" | "permanent";
```

`providerState.archived` 继续表示 provider 原生存储事实，不能被前端直接当成跨 provider 产品状态。Daemon 将 provider 原生状态和 RAH registry 投影成 `libraryState`。

Adapter 增加：

```ts
archiveStoredSession?(session): Promise<void> | void;
restoreStoredSession?(session): Promise<void> | void;
removeStoredSession?(session): Promise<void> | void;
```

`SessionActionCapabilities` 最终应区分 `archive` 与 `restore`。UI 面向 stored Session 时使用 daemon 计算后的 Library capability，不从 running Session capability 猜测。

HTTP API：

```text
POST /api/history/sessions/archive
POST /api/history/sessions/restore
POST /api/history/sessions/remove
```

三个接口都返回新的 `ListSessionsResponse` 和 catalog revision。

## 4. RAH Archive Registry

RAH 使用独立的版本化 registry，而不是复用 `hiddenSessionKeys`：

```ts
interface StoredSessionArchiveRecord {
  provider: ProviderKind;
  providerSessionId: string;
  archivedAt: string;
  backend: StoredSessionArchiveBackend;
  workspaceDir?: string;
  snapshot: StoredSessionRef;
}
```

要求：

- 以 `{provider, providerSessionId}` 为唯一键；
- 使用临时文件 + rename 原子持久化；
- 保存 metadata snapshot，provider 暂时不可用时 Archived 页面仍能列出条目；
- registry 不保存完整 transcript；
- provider 文件重新出现时合并更新 title、preview、activity 和 historyMeta；
- Delete 成功后删除 registry 记录；
- Restore 成功后删除 registry 记录；
- native provider 在 RAH 外部完成 Unarchive 时，catalog reconciliation 清除过期 native record；
- overlay provider 的 registry 始终是可见性权威。

`hiddenSessionKeys` 继续只服务于删除后的陈旧索引抑制和临时 UI 隐藏；运行 Session 不得自动解除 Archive。

## 5. Provider 映射

### 5.1 Codex

- Archive：`thread/archive`。
- Restore：`thread/unarchive`。
- provider 的 `sessions`/`archived_sessions` 是原生权威状态。
- RAH registry 保存操作 metadata，用于失败恢复和 UI 时间戳。
- 发现外部 archived thread 时，即使 registry 不存在也投影为 Archived。
- 发现 registry 标记为 `provider_native`、但 provider 明确报告未归档时，清除过期 registry。

### 5.2 Claude Code local

使用 `rah_snapshot` 物理隔离：

- Archive 将 provider JSONL 从 `~/.claude/projects` 原子移动到
  `~/.rah/runtime-daemon/provider-archives/claude/files`；
- 独立 manifest 保存 Session ID、原始绝对路径、隔离路径、大小、mtime、SHA-256、状态和会话快照；
- manifest 使用 `pending_archive` / `pending_restore` 两阶段状态，进程异常退出后可以恢复已完成的文件移动；
- Restore 校验大小与 SHA-256 后原路移回；目标路径已存在时拒绝覆盖；
- Delete 把隔离副本移入系统 Trash 后才删除 manifest；
- Claude CLI 自己的 `/resume` 列表不再看到已隔离 Session。

### 5.3 OpenCode

- Archive 调用 OpenCode 官方 server API：`PATCH /session/:id`，body 为
  `{ "time": { "archived": <timestamp> } }`。
- 当前数据库 `time_archived` 可被发现并投影为 provider-native archive，RAH registry 只保存跨 provider 的恢复与 UI metadata。
- OpenCode 1.18.4 的公开 schema 只接受数值，实测 `archived: null` 会被静默忽略；在官方 Unarchive API 出现前，Restore 对已验证的原生字段做单列受控清空并立即回读验证。
- 已有 `time_archived != null` 记录迁移进入 Archived 列表。
- Delete 调用 [OpenCode 公开 CLI](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/cli.mdx) 的 `opencode session delete <sessionID>`，命令成功后再次查询 SQLite 验证根记录已经消失；不得继续写 `time_archived` 冒充 Delete。

## 6. Daemon 事务

### 6.1 Stopped Session Archive

```text
resolve canonical StoredSessionRef from the resident catalog
  -> provider native archive（若支持）
  -> commit RAH registry
  -> patch the resident projected catalog
  -> publish one discovery revision
```

同步请求不得在归档前后扫描完整 provider catalog，也不得向 Web 回传完整历史目录；provider watcher 后续负责元数据对账。

provider 动作失败时不得写 registry。

### 6.2 Running Session Archive

```text
mark archiving operation
  -> close runtime
  -> wait until provider writer is closed
  -> execute stopped archive flow
```

如果 close 成功但 archive 失败，Session 保持 `stopped + workspace`，返回可见错误；不得悄悄从侧栏移除。

### 6.3 Restore

```text
resolve archived record
  -> provider native restore（若 backend=native）
  -> remove registry record
  -> refresh catalog
  -> publish one discovery revision
```

provider restore 失败时保留 registry，Session 继续显示在 Archived。

### 6.4 Delete

```text
require stopped
  -> resolve archived/normal record
  -> provider remove/trash
  -> remove registry and catalog cache
  -> publish removal revision
```

删除当前仍在普通会话库的 Session 必须经过显式危险确认；批量删除只接受服务端重新解析的身份集合，不能信任前端传入的路径范围。

## 7. Catalog 与同步

- catalog worker 只扫描 metadata，不加载完整 transcript；
- provider 当前完整 catalog 是 `{provider, providerSessionId}` 身份、存在性和可见性的唯一权威；
  workbench snapshot、remembered sessions/recent、metadata cache 与 stored-history replay runtime
  只能加速启动或展示，不能独立创造一条 Session；
- 同一 provider identity 出现多个物理文件时只投影一个 canonical row；普通 catalog 与 archive
  同时命中时按 provider library fact 选择 placement，不能在 Sidebar 显示两份；
- provider 完整扫描会删除旧快照中已移除或被产品边界过滤的 row；扫描不完整或 provider 失败时
  保留该 provider 的 last-good rows，避免瞬时 I/O 错误导致列表消失；
- Codex catalog 读取 `session_meta.payload` 区分用户根会话与内部执行记录：
  `originator=Codex Desktop` 与 `originator=codex_work_desktop` 都进入 catalog；只排除
  `source/thread_source` 明确标记的 internal subagent rollout；Codex/Claude/OpenCode 尚未接受
  真实用户 turn 的 metadata-only 启动空壳同样不进入 catalog；这些 provider 文件仍保留在原位置；
- `all` 模式返回 Archived 与普通 Session，由 `libraryState` 区分；
- `recent` 默认排除 Archived，避免归档项重新进入 Recent；
- discovery delta 必须把 `libraryState` 纳入 equality key；
- 前端收到 archive/restore response 后以 revision 合并，不长期维护本地 tombstone；
- Sidebar 在初始轻量响应后异步加载完整 catalog，加载期间不阻塞页面可用性；
- watcher 发现 provider 外部 archive/unarchive 时产生同样的 delta。

## 8. 迁移

1. 读取旧 workbench state，不改变 `running/stopped`。
2. Codex `archived_sessions` 自动投影成 native Archived。
3. OpenCode `time_archived != null` 自动投影成 native/observed Archived。
4. 旧 `hiddenSessionKeys` 不自动迁移为 Archive，因为无法区分删除 tombstone 与用户隐藏。
5. 已归档但缺少 workspace metadata 的 Session 进入 `Unknown workspace` 分组。
6. 新协议字段均为 optional，旧客户端仍可读取响应；新客户端对缺失字段回退到 `providerState.archived`。

## 9. 测试门槛

### Protocol/registry

- archive record 的校验、去重、版本迁移和损坏文件隔离；
- atomic write；
- `libraryState` 进入 catalog equality/delta。

### Provider

- Codex archive 后调用 restore，RPC 顺序正确；
- Claude archive 物理移动 transcript，manifest 可恢复原路径，冲突时拒绝覆盖；
- OpenCode 能发现 archived row 并恢复 `time_archived`；
- provider 操作失败时 registry 不前进。

### Runtime

- running Session 可作为一个原子操作关闭并进入 Archived，前端先乐观隐藏；
- stopped archive/restore 在一个 discovery revision 中完成；
- archive 失败后仍在普通列表；
- Delete 同时清理 registry 和 catalog。
- remembered/workbench/cache 中存在、但完整 provider catalog 与 live runtime 都不存在的 identity
  不会进入 response；
- Codex Desktop 的全部用户根会话都会进入普通/归档列表；internal subagent 不进入，同 identity 的
  重复物理 rollout 只投影一行；三家 provider 的 metadata-only 空壳均不进入目录；
- 完整扫描清理 stale cache，不完整扫描保留 last-good provider rows。

### Web

- All 与 Archived 严格互斥；
- Sidebar 合并 running/stored 后按 identity 去重；
- Sidebar 只展示能由用户已登记工作区认领的有效 Session；live runtime 不会自动注册新的工作区；
- stopped row 能打开历史，running row 打开现有 runtime；
- Archive/Restore 后 Sidebar 与 Chats 同步；
- 大目录使用 metadata 渲染，不触发 transcript 请求。

## 10. 落地顺序

1. 协议类型、registry 与 catalog 投影。
2. Restore API 和 Codex 原生 Restore。
3. Claude/OpenCode overlay 与现有 archive 数据迁移。
4. Archived tab、Restore/Delete UI。
5. Sidebar 合并全部非归档根 Session。
6. running Archive 原子 daemon 命令。
7. 删除语义统一、批量删除与 Claude durable snapshot。

每一步都必须保持旧客户端可启动，并在进入下一步前通过定向测试和全量 typecheck。

## 11. 当前落地状态（2026-07-28）

已完成：

- `StoredSessionRef.libraryState`、archive backend 与 remove disposition 协议；
- 原子持久化的 `session-library.json` registry、损坏文件隔离与 provider-missing metadata snapshot；
- Codex `thread/archive` / `thread/unarchive`，以及 provider 外部 restore 后的 native registry reconciliation；
- Claude 的 `rah_overlay` archive/restore；
- OpenCode 已归档记录发现、restore，以及公开 CLI 永久 Delete；
- `/archive`、`/restore`、`/remove` API 与 catalog revision 同步；
- running Session 的 daemon 内 `close -> archive` 操作，失败时回退为 `stopped + workspace`；
- Recent 排除 Archived，Chats 增加 Archived tab、Restore、单条与筛选批量 Remove；
- 左侧 workspace 合并 running/stopped 非归档根 Session，并按 provider identity 去重；
- Sidebar 与 Chats 统一消费 provider-authoritative catalog；旧 remembered/workbench/cache 不再复活
  已删除、已过滤或已重新分类的 identity；
- Codex catalog 已统一接纳 `Codex Desktop` 与 `codex_work_desktop` 创建的用户根会话，同时隔离
  internal subagent rollout，并通过版本化 snapshot / metadata cache 迁移清理旧可见行；
- 完整/不完整 provider scan 已分别实现 prune 与 last-good preservation，刷新和 focus 不再改变
  Session 数量或排序；
- Codex/Claude 的 system Trash 与 OpenCode permanent delete 在 UI 文案中显式区分。

后续增强不阻塞当前 archive 主链路：

- Claude `rah_snapshot` durable archive；
- 跨 provider 批量删除的 daemon batch endpoint 与部分失败报告；
- 超大 workspace Session 清单虚拟化；
- stored-history capability 独立对象，替代 UI 对 adapter 能力的默认推断。
