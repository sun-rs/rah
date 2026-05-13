# RAH Docs

本文是 RAH 项目文档入口。优先阅读顺序如下。

## 1. 当前稳定设计

- [Native Local Server 重构计划](../RAH_NATIVE_LOCAL_SERVER_REFACTOR_PLAN.zh-CN.md)
- [Native Local Server 重构 Goal](../RAH_NATIVE_LOCAL_SERVER_REFACTOR_GOAL.zh-CN.md)
- [当前系统设计总览](./current-system-design.zh-CN.md)
- [Session 入口与权限边界](./session-entry-capability-boundary.zh-CN.md)
- [RAH 1.0 RC 说明](./1.0-rc-notes.zh-CN.md)
- [Claude Zellij Native Mode 边界](./claude-zellij-native-mode.zh-CN.md)
- [Council Listening Control 边界](./council-listening-control.zh-CN.md)
- [Session Controls 重构设计](./session-controls-refactor-design.zh-CN.md)
- [Zellij Mux Backend 状态](../RAH_ZELLIJ_MUX_BACKEND_STATUS.zh-CN.md)
- [Zellij Mux Backend 完成审计](../RAH_ZELLIJ_MUX_BACKEND_COMPLETION_AUDIT.zh-CN.md)
- [PTY-first 无缝工作台计划](../RAH_PTY_FIRST_SEAMLESS_WORKBENCH_PLAN.zh-CN.md)
- [PTY-first 进度与验收审计](./pty-first-progress-audit.zh-CN.md)
- [PTY-first 完成审计](../NATIVE_TUI_COMPLETION_AUDIT.zh-CN.md)
- [PTY-first 人类 QA 交付说明](../NATIVE_TUI_HUMAN_QA_HANDOFF.zh-CN.md)
- [项目总览](./project-overview.zh-CN.md)
- [历史浏览与分页边界](./history-browsing.zh-CN.md)

## 2. Provider 与能力边界

- [Provider Capability Matrix](./provider-capability-matrix.md)
- [Provider Capability Protocol Draft](./provider-capability-protocol-draft.md)
- [Provider Adapter 协议与能力边界](./provider-adapter-protocol.zh-CN.md)
- [Provider Adapter Maintenance](./provider-adapter-maintenance.md)
- [Canonical Event Taxonomy](./canonical-event-taxonomy.md)
- [Codex Adapter Event Coverage](./codex-event-coverage.md)

## 3. 历史、状态与质量

- [Codex 历史 liveness 与 pending tool 收口边界](./codex-history-liveness.zh-CN.md)
- [History Quality Plan](./history-quality-plan.zh-CN.md)
- [Client Web Store Ownership](./client-web-store-ownership.zh-CN.md)
- [Workbench Boundary](./workbench-boundary.md)

## 4. 发布与回归

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
