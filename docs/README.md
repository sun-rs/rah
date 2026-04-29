# RAH Docs

本文是 RAH 项目文档入口。优先阅读顺序如下。

## 1. 当前稳定设计

- [当前系统设计总览](./current-system-design.zh-CN.md)
- [项目总览](./project-overview.zh-CN.md)
- [Session 入口与权限边界](./session-entry-capability-boundary.zh-CN.md)
- [历史浏览与分页边界](./history-browsing.zh-CN.md)

## 2. Terminal Handoff

- [Terminal Wrapper Live Session 设计](./terminal-wrapper-live-sessions.zh-CN.md)
- [`rah codex` handoff 模式](./rah-codex-handoff-mode.zh-CN.md)
- [`rah claude` handoff 模式](./rah-claude-handoff-mode.zh-CN.md)
- [`rah codex` 标准交付文档](./rah-codex-wrapper.zh-CN.md)
- [Terminal Wrapper Protocol Draft](./terminal-wrapper-protocol.zh-CN.md)

## 3. Provider 与能力边界

- [Provider Capability Matrix](./provider-capability-matrix.md)
- [Provider Capability Protocol Draft](./provider-capability-protocol-draft.md)
- [Provider Adapter 协议与能力边界](./provider-adapter-protocol.zh-CN.md)
- [Provider Adapter Maintenance](./provider-adapter-maintenance.md)
- [Canonical Event Taxonomy](./canonical-event-taxonomy.md)
- [Codex Adapter Event Coverage](./codex-event-coverage.md)

## 4. 历史、状态与质量

- [Codex 历史 liveness 与 pending tool 收口边界](./codex-history-liveness.zh-CN.md)
- [History Quality Plan](./history-quality-plan.zh-CN.md)
- [Client Web Store Ownership](./client-web-store-ownership.zh-CN.md)
- [Workbench Boundary](./workbench-boundary.md)

## 5. 发布与回归

- [Release Checklist](./release-checklist.md)
- [UI 回归清单](./ui-regression-checklist.zh-CN.md)
- [Protocol Freeze Status](./protocol-freeze-status.md)
- [Architecture Benchmark](./architecture-benchmark.zh-CN.md)

## 维护规则

- 面向用户/产品边界的说明优先写中文文档。
- 协议、事件分类、provider matrix 这类需要和代码结构紧密对应的文档可以保留英文。
- 新增 provider 或改变 session/control/history 语义时，至少同步更新：
  - [当前系统设计总览](./current-system-design.zh-CN.md)
  - [Session 入口与权限边界](./session-entry-capability-boundary.zh-CN.md)
  - [历史浏览与分页边界](./history-browsing.zh-CN.md)
  - [Provider Capability Matrix](./provider-capability-matrix.md)
