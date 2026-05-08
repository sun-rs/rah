# History Quality Plan

日期：2026-05-08

本文件记录当前 PTY-first 主线下的历史浏览质量边界。旧版本曾覆盖 Codex、Claude、Gemini、Kimi、OpenCode 五家 provider；Gemini/Kimi CLI 一等支持已移除，历史浏览质量计划也同步收敛到 Codex、Claude、OpenCode。

## 当前目标

历史浏览必须服务两个核心场景：

- 不启动 live TUI 时，快速浏览 provider 原厂 session 文件。
- Claim / resume 后，Chat mirror 能从 provider 原厂 jsonl/db/session history 文件追上真实 TUI 会话。

结构化历史只能来自 provider 原厂数据源，不能从 ANSI/TUI screen scrape 反推。

## 当前 Provider 范围

| Provider | 原厂数据源 | 当前定位 |
|---|---|---|
| Codex | rollout JSONL / Codex session metadata | core live + history mirror |
| Claude | Claude Code JSONL session files | core live + history mirror |
| OpenCode | OpenCode SQLite / session records | core live + API-key 聚合入口 |

Gemini/Kimi 模型的新工作通过 OpenCode/API provider 承载，不再维护 Gemini CLI / Kimi CLI 的独立 history parser、cache、paging 或 QA gate。

## 设计原则

1. Correctness before cleverness：打开历史时冻结，向上翻页不漂，claim 后老历史不被新内容污染。
2. Adapter owns parsing semantics：runtime 只负责 snapshot lifecycle、snapshot transfer 和通用 paging contract。
3. Optimize the hot path only：只优化首屏、向上连续翻页、同一 session 反复打开。
4. Mirror failure is diagnostics：history/mirror 缺失或失败不能影响真实 TUI session。
5. No ANSI chat scraping：Terminal 输出只用于 TUI view，不作为 structured Chat 数据源。

## 当前验收

- Codex / Claude / OpenCode history loader 能返回稳定 recent window。
- Older page cursor 不因为滚动补页导致视口跳到新页顶部。
- Live/history echo 通过 canonical identity 和前端 upsert 防重复。
- Chat mirror 失败进入 diagnostics，不关闭 PTY/TUI。
- Gemini/Kimi CLI 相关历史质量项从 release gate 中移除。

## 后续关注

- 长历史滚动性能和 cursor 稳定性仍需真实大 session 验证。
- OpenCode 作为 API-key 聚合入口时，模型 provider 变化可能影响 DB 记录结构，需要在 OpenCode 专项 QA 中覆盖。
- iPad/Safari 页面恢复后，history/chat mirror 是否追上当前 TUI，需要人类测试。
