# client-web store ownership

这份文档只描述 `packages/client-web` 的状态 ownership 边界。

目标不是把文件越拆越碎，而是把**不同职责的状态迁移**固定到清楚的模块里，避免以后再把逻辑重新塞回 `useSessionStore.ts`。

## 原则

1. `useSessionStore.ts` 只做 orchestration shell
- 暴露 Zustand state 和 actions
- 组合模块能力
- 保持对外 API 稳定

2. 具体状态迁移必须归属到明确模块
- 不在 store 壳里直接展开一大段流程
- 不把 provider/workspace/history/transport 混成一团

3. 新逻辑优先放到已有 ownership 模块
- 如果是 transport 相关，进 `session-store-transport.ts` 或 `session-store-sync.ts`
- 如果是 projection/event 应用，进 `session-store-projections.ts`
- 如果是 history paging/bootstrap，进 `session-store-history*.ts`
- 如果是 workspace/session catalog，进 `session-store-workspace.ts`
- 如果是 session lifecycle/command/startup，进对应 `session-store-session-*.ts`

4. 只有在没有现成 owner 时，才新增模块
- 新模块应该按职责切
- 不按“为了拆文件而拆文件”切

## 当前 ownership

### `useSessionStore.ts`
- Zustand state shape
- 对外 action surface
- 模块组合和少量 bridge

### `session-store-bootstrap.ts`
- client id
- init one-shot gate
- last history selection restore
- 基础错误文本

### `session-store-sync.ts`
- event stream sync
- replay gap recovery
- transport reconnect orchestration

### `session-store-transport.ts`
- events socket 生命周期
- reconnect timer
- discovery refresh timer

### `session-store-projections.ts`
- event -> projection 应用
- unread 计算
- sessions response merge / replace
- projection summary update / provider-session adopt

### `session-store-workspace.ts`
- workspace path normalization
- hidden/reveal rules
- workspace selection reconciliation
- stored/live session workspace 归属判断

### `session-store-history.ts`
- authoritative history prepend
- history replay -> projection
- history selection 持久化同步

### `session-store-history-bootstrap.ts`
- pending/deferred history bootstrap buffers
- bootstrap defer rules

### `session-store-history-paging.ts`
- ensure history loaded
- load older history

### `session-store-history-selection-sync.ts`
- history selection subscription bridge

### `session-store-session-lifecycle.ts`
- start/resume/attach/claim/close 这类状态变更模板

### `session-store-session-commands.ts`
- attach / close / control / interrupt / send / permission respond

### `session-store-session-startup.ts`
- start session
- start scenario
- activate history
- resume stored session
- claim history session

## 以后不要做的事

1. 不要在 `useSessionStore.ts` 里直接写长篇 transport 逻辑
2. 不要在 `useSessionStore.ts` 里直接写完整 history paging 逻辑
3. 不要在 `useSessionStore.ts` 里直接展开 workspace reconciliation
4. 不要把新的 session command/startup 分支直接塞回 store 壳
5. 不要为了图省事把 selector/contract 再塞进 store

## 判断标准

新增一段逻辑前，先问：

- 这是 transport、projection、workspace、history、还是 session lifecycle？
- 这个状态迁移已经有 owner 吗？
- 如果有，改 owner，不改壳
- 如果没有，再新增一个小模块

一句话：

**`useSessionStore.ts` 应该是薄壳；真正拥有状态迁移的，是对应 ownership 模块。**
