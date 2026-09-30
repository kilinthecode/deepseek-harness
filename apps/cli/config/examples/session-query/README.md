# Session search overlay

English | [中文](README.zh.md)

This directory is an opt-in Cordis overlay that opens `@deepseek-ai/dsh-session-query-sqlite` with a durable `path` under the harness home and `openAt: startup`, and mounts `@deepseek-ai/dsh-tool-session-query`. It does not add LLM summarization.

Shipped profiles keep both off: the base bundle sets `openAt: never` on `session-query-sqlite` and does not mount the tools. That is the recorded decision in the [session-search-not-shipped-default note](../../../../../.agents/notes/archived/feature/2026-08-02-session-search-not-shipped-default.md) and the [content-search opt-in note](../../../../../.agents/notes/archived/architecture/2026-08-13-session-content-search-opt-in.md).

From a development checkout:

```sh
pnpm dsh web --patch apps/cli/config/examples/session-query/session-query.cordis.yml
```

Replace `web` with `tui` or `headless` for those profiles. An installed `dsh` must add `@deepseek-ai/dsh-tool-session-query` to the profile if the installation does not already depend on it (`dsh plugin --profile <name> add @deepseek-ai/dsh-tool-session-query`), then pass the same `--patch`. `@deepseek-ai/dsh-session-query-sqlite` is already a base-bundle row; the overlay only replaces that row's `config`.

The accepted fields are in the [session-query-sqlite README](../../../../../packages/session-query/session-query-sqlite/README.md) and the [tool-session-query README](../../../../../packages/session-query/tool-session-query/README.md). Durable memory is separate: [Remember across sessions](../../../../../docs/user/guide/memory.md).
