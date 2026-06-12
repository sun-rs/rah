# RAH Docs

本文是 RAH 当前 `main` 的文档入口。旧分支计划、goal 正文和阶段性审计文档已经从仓库根目录移除；需要追溯旧设计时使用 git history。

## 1. 当前稳定设计

- [当前系统设计总览](./current-system-design.zh-CN.md)
- [项目总览](./project-overview.zh-CN.md)
- [Session 入口与权限边界](./session-entry-capability-boundary.zh-CN.md)
- [历史浏览与分页边界](./history-browsing.zh-CN.md)
- [RAH 1.0 里程碑说明](./1.0-notes.zh-CN.md)
- [Claude Tmux Native Mode 边界](./claude-tmux-native-mode.zh-CN.md)
- [Council Listening Control 边界](./council-listening-control.zh-CN.md)
- [Session Controls 重构设计](./session-controls-refactor-design.zh-CN.md)
- [Scrollbar UI 协议](./ui-scrollbar-protocol.zh-CN.md)
- [远程访问：Tailscale、Cloudflare 与 Surge 共存](./remote-access-tailscale-cloudflare.zh-CN.md)
- [Council MCP Session Projection](./council-mcp-projection.zh-CN.md)

## 2. Provider 与能力边界

- [Provider Scope: Codex + Claude + Gemini + OpenCode](./provider-scope-codex-claude-opencode.zh-CN.md)
- [Provider Capability Matrix](./provider-capability-matrix.md)
- [Provider Adapter 协议与能力边界](./provider-adapter-protocol.zh-CN.md)
- [Provider Adapter Maintenance](./provider-adapter-maintenance.md)
- [Canonical Event Taxonomy](./canonical-event-taxonomy.md)
- [Codex Adapter Event Coverage](./codex-event-coverage.md)
- [Chatbox Ledger Architecture](./chatbox-ledger-architecture.zh-CN.md)

## 3. 历史、状态与质量

- [Codex 历史 liveness 与 pending tool 收口边界](./codex-history-liveness.zh-CN.md)
- [History Quality Plan](./history-quality-plan.zh-CN.md)
- [Client Web Store Ownership](./client-web-store-ownership.zh-CN.md)
- [Workbench Boundary](./workbench-boundary.md)

## 4. 发布与回归

- [Release Checklist](./release-checklist.md)
- [UI 回归清单](./ui-regression-checklist.zh-CN.md)
- [Provider Regression Testing](./provider-regression-testing.zh-CN.md)
- [Native TUI Real CLI QA](./native-tui-real-cli-qa.zh-CN.md)
- [Production Regression E2E Suite](./production-regression-e2e-suite.zh-CN.md)

## 维护规则

- 面向用户/产品边界的说明优先写中文文档。
- 协议、事件分类、provider matrix 这类需要和代码结构紧密对应的文档可以保留英文。
- 新增 provider 或改变 session/control/history 语义时，至少同步更新：
  - [当前系统设计总览](./current-system-design.zh-CN.md)
  - [Session 入口与权限边界](./session-entry-capability-boundary.zh-CN.md)
  - [历史浏览与分页边界](./history-browsing.zh-CN.md)
  - [Provider Capability Matrix](./provider-capability-matrix.md)
