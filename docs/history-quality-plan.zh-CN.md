# History Quality Plan

这份文档定义 RAH 下一阶段的历史浏览质量优化路线。

目标不是继续堆特例，而是在**现有 adapter-owned frozen history loader** 基础上，继续提升：

- 首屏 recent window 的语义完整性
- 向上翻页时的稳定性和效率
- Gemini 的重复打开/翻页成本

非目标：

- 不重写 canonical protocol
- 不重写 `HistorySnapshotStore`
- 不把四家 provider 强行收成一个完全相同的底层实现

## 当前基线

当前四家 provider 都已经具备：

- adapter-owned metadata catalog
- adapter-owned frozen history loader
- claim 后 replay -> live 的 frozen snapshot transfer

当前差异：

- `Claude / Codex / Kimi`
  - 已有 recent window + older cursor
  - 已接入第一版 `semantic rewind`
  - 基于文件尾部窗口读取
- `Gemini`
  - 已有 adapter-owned frozen loader
  - 已有 page-based sidecar event cache
  - frozen loader 已优先使用 windowed cache read

## 设计原则

### 1. Correctness before cleverness

历史浏览必须始终满足：

- 打开时冻结
- 向上翻页不漂
- claim 后老历史不被新内容污染

如果“更快”会破坏这三个条件，就不接受。

### 2. Adapter owns parsing semantics

`runtime` 只负责：

- frozen snapshot lifecycle
- snapshot transfer
- 通用 paging contract

`adapter` 自己负责：

- provider 原始文件理解
- metadata 提取
- recent window 生成
- older page 生成
- provider-specific cache/index

### 3. Optimize the hot path only

只优化真正重复发生的路径：

- 打开历史首屏
- 向上连续翻页
- 同一 session 反复打开

不为了低频边角引入大型基础设施。

## 方案 A: Codex / Claude / Kimi 的 semantic rewind

### 当前问题

当前第一版 recent window 是：

- 从文件尾部读取一段 raw record window
- 全量翻译该窗口
- 取最后 N 条 canonical events

这已经保证 frozen 不漂，但不保证“首屏语义足够完整”。

例如：

- 可能首屏只有最后一条 assistant message
- 对应的最后一条 user_message 没带上来
- 或者 tool/permission 刚好从窗口中间切断

### 目标

在不引入大而重 checkpoint 系统的前提下，让首屏更像“一个完整的最近 turn”。

### 最小设计

对 `Codex / Claude / Kimi` 增加一个 **semantic rewind pass**：

1. 先按当前方式得到 recent canonical window
2. 检查窗口开头是否满足“可展示边界”
3. 如果不满足，就继续向前扩窗，再重新翻译
4. 到达安全边界或达到上限后停止

### 安全边界定义

第一版不追求绝对完美，只定义几条简单且稳的规则：

- 如果窗口里存在 assistant/reasoning/tool/permission，但没有最近的 user_message，则继续向前扩
- 如果窗口开头仍处于未闭合状态，则继续向前扩：
  - `Codex`
    - pending tool call
    - pending patch/custom tool result
  - `Kimi`
    - pending tool result
    - step begin without enough surrounding turn context
  - `Claude`
    - 最近 assistant/tool 之前没有可见 user turn

### 实现边界

第一版只做：

- “扩窗 + 重翻译”

不做：

- persistent checkpoint database
- cross-session global rewind index

### 为什么这是对的

因为这能解决最明显的体验问题：

- 首屏只看到 assistant，没有用户问题
- 首屏刚好切在工具调用中间

同时不会把系统复杂度一下拉高。

## 方案 B: Codex / Claude / Kimi 的轻 checkpoint

### 为什么还需要 checkpoint

仅靠“扩窗 + 重翻译”可以提升正确性，但连续向上翻页时，仍会重复做大量窗口翻译。

### 最小设计

只做 **session-local ephemeral checkpoint**：

- 生命周期：只存在于当前 daemon / 当前 frozen snapshot
- 不持久化到磁盘
- 仅用于当前 session 历史翻页

checkpoint 内容：

- `rawStartOffset`
- `rawEndOffset`
- provider translation state snapshot

checkpoint 生成策略：

- 只有当某个窗口已经被完整翻译过一次
- 且窗口规模超过阈值
- 才记录一个 checkpoint

### 为什么先做 ephemeral

因为：

- 复杂度明显低于磁盘持久 checkpoint
- 足够覆盖同一次浏览中的重复翻页
- 不引入额外的 cache invalidation 问题

### 当前推荐顺序

先：

- `semantic rewind`

后：

- `ephemeral checkpoint`

不建议一上来直接做 persistent checkpoint。

## 方案 C: Gemini 的 event index

### 当前问题

`Gemini` 虽然已经有 sidecar event cache，但目前还是：

- miss 时整份 conversation materialize
- cache 命中后整份 events 直接读出

这已经比以前强，但还不是最优。

### 目标

把 Gemini 从“整份 event cache”提升成“分段 event index”。

### 最小设计

sidecar 文件按 **page/chunk** 保存：

- `revision`
  - `fileSize`
  - `mtimeMs`
- `pages`
  - page 0
  - page 1
  - ...
- 每页保存：
  - canonical events
  - page start/end event index
  - optional message range

这样：

- 首次 materialize 仍可生成完整 pages
- 但读取时不必把整份 events 全反序列化进内存
- 可以只加载最近一页或少数几页

### 为什么 Gemini 不跟三家共用 raw tail

因为 Gemini 的源文件经常是 monolithic JSON，而不是稳定的 line-oriented record stream。

所以：

- `Codex / Claude / Kimi`：更适合 raw window + rewind
- `Gemini`：更适合 event index / page cache

## 优先级

### Phase 1

优先做：

1. `Codex / Claude / Kimi` semantic rewind
2. `Gemini` page-based event cache

这是“提升体验但不过度设计”的最优组合。

当前状态：

- `Codex / Claude / Kimi` semantic rewind：已完成
- `Gemini` page-based event cache：已完成
- `Codex / Claude / Kimi` loader-local semantic cursor：已完成
- `Codex / Claude / Kimi` phase-1 ephemeral checkpoint：已完成

### 补充说明：为什么还需要 semantic cursor

仅有 `semantic rewind` 还不够。

如果首屏 recent window 因为 rewind 多带上了一些更早事件，那么：

- 这页真正展示的起点
- 原始文件窗口的起点

就不再是同一个边界。

如果 older page 仍然只靠原始 `endOffset` 继续往前读，就会有风险：

- 被 rewind 多带上的那部分之前事件可能在后续分页里被跳过

因此 line-oriented providers 现在额外做了一层 **loader-local semantic cursor**：

- cursor 不再只是简单 byte offset
- 而是 provider loader 持有的 opaque state
- state 里包含：
  - 下一个更老原始窗口的 `endOffset`
  - 当前页被 rewind 排除出去、但仍应出现在后续 older page 里的 `carryEvents`

这样：

- semantic rewind 仍然能提升首屏完整性
- older paging 不会因为 rewind 而产生 gap
- runtime 仍然不需要理解 provider 文件格式

### Phase 2

如果连续翻页仍然偏重，再做：

- `Codex / Claude / Kimi` ephemeral checkpoint

当前状态更新：

- 已经完成 **phase-1 ephemeral checkpoint**
- 这不是大而重的 translator-state snapshot
- 而是针对同一 `endOffset` 扩窗时，复用一个从安全 user-turn 边界开始的已知 suffix

它的特点是：

- session-local
- loader-local
- 不持久化
- 不改 runtime protocol
- 不要求 runtime 理解 provider 文件格式

### Phase 3

只有在实测表明有必要时，才考虑：

- persistent checkpoint/index
- 更复杂的 provider-specific rewind metadata

## 明确不做

当前不做：

- 所有 provider 统一底层算法
- 全局持久 checkpoint 框架
- 打开历史时预热所有 session 全量 canonical cache

原因：

- 这会明显增加复杂度
- 当前并不需要
- 与“按需读取”目标相违背

## 一句话结论

下一阶段最值得做的不是新框架，而是：

- 给 `Codex / Claude / Kimi` 增加 **semantic rewind**
- 给 `Gemini` 把 sidecar cache 升成 **page-based event index**

这两件事成本可控，收益最大，也最符合 RAH 当前架构。
