# Agent Note: SDK 与 headless 图像提示会根据 route 进行校验

Status: implemented

[English](2026-09-23-route-checked-image-prompts.md) | 中文

## 问题

图像输入在支持图像的路由上早已端到端可用，但有三个非浏览器入口掩盖了它是否可用：

- JSON-RPC SDK 服务器在所有路由上都接受图像提示。在声明仅支持文本输入的路由上，`LlmRuntime` 会用占位文本替换每张图像，因此调用方收到纯文本回答且没有任何错误。
- headless profile 没有提供附加图像的方式。
- ACP、TypeScript 和 Python SDK 以及 `dsh-subagent-dsh-sdk` 默认使用 `deepseek-v4-flash`，由于随附的 DeepSeek 目录已将其移除，该名称会作为仅支持文本输入的路由直接透传。以默认选项发送的图像会被 ACP 拒绝，或被 SDK 静默降级。

## 决策

### 单一映射，策略归调用方

`@deepseek-ai/dsh-llm` 中的 `imageInputSupport(info)` 将已解析模型的 `inputModalities` 映射为 `'supported'`、`'unsupported'` 或 `'undeclared'`。调用方自行解析模型信息，并为 `'undeclared'` 选择各自的策略。

### 提示入口的门控是宽松的

SDK 服务器的 `session/prompt` 与 headless 的 `--image` 选项只拒绝 `'unsupported'`。SDK 的检查在 Session 创建或附件存储之前运行；headless 的检查在任何文件被读取以及 Agent 创建之前运行。`'unsupported'` 正是 `LlmRuntime` 用占位文本替换每张图像的条件，也是 `packages/api/session-controller/src/commands.ts` 中 Web 提示准入拒绝的条件，因此这些门控会拒绝运行时将静默降级的每一个提示。`'undeclared'` 路由会被放行，其图像原样到达适配器：能够发送图像的适配器会发送，不能发送的适配器会在 Session 与附件已经存在之后以 `UNSUPPORTED_CONTENT` 使该轮次失败。`read_image`、MCP 桥接和 ACP 中的门控也会拒绝 `'undeclared'`，因此在未声明模态的路由上，提示中的图像会被放行，而 `read_image` 会拒绝。

### headless 通过 flag 附加图像

`dsh --profile headless --image <path>` 可以重复使用。运行器通过已挂载的文件系统 provider 解析每个路径，并以与 `read_image` 相同的方式确定媒体类型：受支持的扩展名决定媒体类型，无扩展名的路径根据文件签名识别，其他任何扩展名无论文件内容如何都会在读取任何文件之前失败。它用 `attachments.saveImages` 存储整批图像，并发送一条包含任务文本、其后按调用顺序排列图像的用户消息。存储在 Agent 创建或沿用之前进行，因此每一种图像拒绝（包括附件存储的批次与解码拒绝）都不会创建 Session，也不会存储任何图像；而 Agent 步骤本身的失败（例如不可用的 `--session-id`）会留下没有任何 Session 引用的已存储图像。若在 Agent 步骤之后再存储，这些拒绝就会推迟到 Session 创建之后。

### 随附的默认值接受图像

ACP 随附的条目、TypeScript 和 Python SDK 客户端以及 `dsh-subagent-dsh-sdk` 默认使用 `deepseek-flash`，即声明支持图像输入的随附目录条目，因此以默认选项发送的图像能够到达模型，ACP 也会宣告支持图像提示。辅助的 `dsh-web-search-deepseek` provider 保留自己的 `deepseek-v4-flash` 默认值：它把纯文本的搜索请求直接发送到 DeepSeek 的 Anthropic 兼容端点，不经 `ctx.llm` 解析模型，因此路由图像能力与它无关。

## 考虑过的替代方案

**严格的提示入口门控。** 在 SDK 服务器和 headless 中拒绝 `'undeclared'`，会拒绝那些运行时原样支持图像的路由，也会与 Web 提示准入的行为不一致。

**保留 `deepseek-v4-flash` 作为默认值并依赖拒绝行为。** 门控会让默认值响亮地失败，但每个默认路由的图像提示仍然会失败；维护者因此选择了支持图像的默认值。

**将现有的五个门控迁移到 `imageInputSupport`。** 迁移本身是机械性的，但会触及五个包、涉及两种语义；它留作共享映射所支持的后续工作。

**在 headless 任务中使用 `@path` 引用。** 任务位置参数是以空格拼接的自由文本，因此前缀解析存在歧义；可重复使用的 `--image` flag 是明确的。

## 影响

在仅支持文本输入的路由上发送图像的 SDK 自动化，现在会收到 JSON-RPC 错误而不是占位回答。headless 用户可以附加图像，且仅支持文本输入的路由会在任何模型请求之前使调用失败。默认路由的 SDK 与 ACP 会话会运行在 `deepseek-flash` 上，而不是 `deepseek-v4-flash` 的透传。五个路由图像门控在后续迁移完成之前仍保留两种语义。

## 测试

单元测试覆盖了映射（`packages/llm/llm/tests/content.spec.ts`）、Session 创建之前的 SDK 门控（`packages/sdk/server/tests/server.spec.ts`）、headless 选项与运行器（`packages/bundle/headless/tests/startup.spec.ts`、`headless.spec.ts`），以及随附的 ACP 条目（`packages/bundle/acp-app/tests/acp-app.spec.ts`）。无密钥的 `snapshots/session/headless-image-prompt` 场景会回放一次带有一个 `--image` 附件的 headless 运行。
