# 生成图像

[English](image-generation.md) | 中文

在已配置的聊天模型旁使用图像生成模型。代理发现可用图像模型，并返回带可下载原始文件的图像。模型能读取图像不代表能生成图像。

## 启用图像模型

你需要 API 密钥以及所选供应商的图像模型访问权限。将密钥放入启动环境或 harness 凭据存储；配置仅包含它的引用。

[OpenAI 示例 overlay](../../../apps/cli/config/examples/image-generation.patch.yml) 启用一个显式图像模型。如果账户使用其他 GPT Image 模型，请修改模型 ID，然后使用 overlay 启动常用 profile：

```sh
pnpm dsh web --patch apps/cli/config/examples/image-generation.patch.yml
```

如需持久设置，将 overlay 中的插件条目复制到 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 并重启该 profile。也可将同一 overlay 用于 `dsh --profile headless --patch <path> "Generate a watercolor owl"`。

## 选择供应商

[HTTP 供应商参考](../../../packages/llm/image-generation-http/README.zh.md)定义路由字段和限制。每条路由列出精确图像模型；聊天模型选择器独立配置。使用供应商的当前文档选择可用模型。

| 供应商 | `api` | `baseURL` | 常见凭据引用 |
|---|---|---|---|
| [OpenAI](https://developers.openai.com/api/docs/guides/image-generation) | `openai-images` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| [OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/image-generation) | `openrouter-images` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| [Gemini](https://ai.google.dev/gemini-api/docs/generate-content/image-generation) | `google-generate-content` | `https://generativelanguage.googleapis.com/v1` | `GEMINI_API_KEY` |

OpenAI 和 OpenRouter 路由要求模型返回内联栅格图像。Gemini 路由要求模型支持通过 `generateContent` 输出图像。不支持 SVG 和仅 URL 输出。

## 生成并保存

可以要求：“列出图像模型，然后用 OpenAI 图像模型生成一只水彩猫头鹰。”代理通过 `list_image_models` 查找已配置路由，并通过 `generate_image` 显式指定供应商、模型和提示词。请在提示词中描述主体、构图、风格和需要的文字。

每个成功结果包含预览和名为 `generated-1.png` 或相应图像扩展名的原始文件。下载原始文件用于编辑或发布；预览可能为聊天显示而归一化。生成引用保留在已保存的对话中。

图像生成使用供应商的默认尺寸和质量，可能产生单独的 API 费用。请求不会自动重试。缺失密钥、不支持的模型、拒绝、响应限制或存储失败会显示为工具错误；请求再次生成前先修复原因。
