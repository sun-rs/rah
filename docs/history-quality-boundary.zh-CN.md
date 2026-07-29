# History Quality Boundary

复核日期：2026-07-29

本文件记录当前 provider-native 主线下的历史浏览质量边界。当前历史浏览覆盖 Codex、Claude、OpenCode；其它模型家族通过 OpenCode/API provider 承载。

## 当前目标

历史浏览必须服务两个核心场景：

- 不启动 live session 时，快速浏览 provider 原厂 session 历史。
- Resume 后，Chat projection 能与 provider-native live session 收敛。

结构化历史只能来自 provider 原厂数据源，不能从 ANSI/TUI screen scrape 反推。

## 当前 Provider 范围

| Provider | 原厂数据源 | 当前定位 |
|---|---|---|
| Codex | app-server turn/item pages，rollout JSONL fallback | core live + paged history |
| Claude | Claude Code JSONL session files | core live + history mirror |
| OpenCode | OpenCode SQLite / session records | core live + API-key 聚合入口 |

Kimi 模型的新工作通过 OpenCode/API provider 承载，不再维护 Kimi CLI 的独立 history parser、cache、paging 或 QA gate。

## 设计原则

1. Correctness before cleverness：打开历史时冻结，向上翻页不漂，resume 后老历史不被新内容污染。
2. Adapter owns parsing semantics：runtime 只负责 snapshot lifecycle、snapshot transfer 和通用 paging contract。
3. Optimize the hot path only：只优化首屏、向上连续翻页、同一 session 反复打开。
4. Projection failure is diagnostics：history 解析缺失或失败不能杀掉真实 provider session。
5. No ANSI chat scraping：Terminal 输出只用于 TUI view，不作为 structured Chat 数据源。

## 当前验收

- Codex / Claude / OpenCode history loader 能返回稳定 recent window。
- Older page cursor 不因为滚动补页导致视口跳到新页顶部。
- Live/history echo 通过 canonical identity 和前端 upsert 防重复。
- Chat projection 失败进入 diagnostics，不关闭 provider session 或 TUI surface。

## 后续关注

- 长历史滚动性能和 cursor 稳定性仍需真实大 session 验证。
- OpenCode 作为 API-key 聚合入口时，模型 provider 变化可能影响 DB 记录结构，需要在 OpenCode 专项 QA 中覆盖。
- iPad/Safari 页面恢复后，history/chat mirror 是否追上当前 TUI，需要人类测试。
