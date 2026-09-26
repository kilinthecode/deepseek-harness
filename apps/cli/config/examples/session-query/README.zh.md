# 会话搜索覆盖配置

[English](README.md) | 中文

本目录是可选的 Cordis overlay：以 harness home 下的持久 `path` 和 `openAt: startup` 打开 `@deepseek-ai/dsh-session-query-sqlite`，并挂载 `@deepseek-ai/dsh-tool-session-query`。它不会加入 LLM 摘要。

随附 profile 将二者保持关闭：base 组合包把 `session-query-sqlite` 的 `openAt` 设为 `never`，并且不挂载这些工具。这是[不随附 session-search 工具的决策](../../../../../.agents/notes/archived/feature/2026-08-02-session-search-not-shipped-default.md)和[内容搜索需选择启用的决策](../../../../../.agents/notes/archived/architecture/2026-08-13-session-content-search-opt-in.md)所记录的结论。

在开发检出中：

```sh
pnpm dsh web --patch apps/cli/config/examples/session-query/session-query.cordis.yml
```

对这些 profile 把 `web` 换成 `tui` 或 `headless`。若已安装的 `dsh` 尚未依赖 `@deepseek-ai/dsh-tool-session-query`，须先把它加到 profile（`dsh plugin --profile <name> add @deepseek-ai/dsh-tool-session-query`），再传入同一 `--patch`。`@deepseek-ai/dsh-session-query-sqlite` 已是 base 组合包中的一行；该 overlay 只替换该行的 `config`。

受支持字段见 [session-query-sqlite README](../../../../../packages/session-query/session-query-sqlite/README.zh.md) 和 [tool-session-query README](../../../../../packages/session-query/tool-session-query/README.zh.md)。持久记忆是另一条路径：[跨会话记忆](../../../../../docs/user/guide/memory.zh.md)。
