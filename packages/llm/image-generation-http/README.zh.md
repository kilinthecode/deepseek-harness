---
description: "具有有界请求的显式 OpenAI Images、OpenRouter Images 和 Gemini 图像生成 HTTP 路由。"
kind: "package-reference"
---

# @deepseek-ai/dsh-image-generation-http

[English](README.md) | 中文

## 概述

本供应商为显式配置的图像模型实现 `ctx.imageGeneration`。空的 `providers` 字典使服务保持休眠。基础 bundle 挂载此插件；启用路由会激活图像工具，无需更改聊天模型。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 `providers` 中配置命名路由，每条路由包含 `api`、`baseURL` 和非空 `models` 允许列表。`apiKeyEnv` 指定[凭据引用](../../credentials/credentials/README.zh.md)，每次生成通过 `ctx.credentials` 解析；该服务缺席时使用捕获的启动环境。`headers` 提供部署标头；密钥保留在凭据引用中。

| `api` | 追加到 `baseURL` 的操作 | 响应 |
|---|---|---|
| `openai-images` | `/images/generations` | `data[].b64_json` |
| `openrouter-images` | `/images` | `data[].b64_json` |
| `google-generate-content` | `/models/<model>:generateContent` | 第一个候选的可见文本和 `inlineData` |

API 根地址包含版本路径段。仅配置支持所选图像协议且账户可用的模型。图像输入元数据和聊天目录不会填充此允许列表。

`timeoutMs` 默认为 300000，涵盖凭据等待、fetch 和完整响应体接收。`maxResponseBytes` 默认为 33554432，限制包含 JSON 和 base64 的编码响应字节。消费者持久化解码图像时另行应用[附件限制](../../attachment/attachment-local/README.zh.md)。可执行 overlay 见[生成图像](../../../docs/user/guide/image-generation.zh.md)。

<a id="understand-the-implementation"></a>
## 理解实现

配置验证拒绝不支持的协议、空白或重复模型 ID、缺失模型列表、无效凭据引用或标头，以及包含嵌入凭据、查询字符串或片段的 API 根地址。准备后的请求捕获分离的配置。调用方取消、超时或卸载会停止未完成请求；卸载等待它们结束。

请求不自动重试，也不跟随重定向。HTTP 错误、拒绝、无效 JSON/base64、不支持的栅格格式、与声明媒体类型不符以及没有最终图像的响应都会使生成失败。Gemini 思考部分被省略。供应商仅接收内联字节，不下载远程图像 URL。

没有运行时不变量伴随模块：请求结束和服务卸载由单一所有者负责，没有独立维护的投影。

<a id="further-exploration"></a>
## 深入阅读

- [图像生成服务](../image-generation/README.zh.md) — 供应商和消费者的责任。
- [OpenAI Images API](https://developers.openai.com/api/docs/guides/image-generation)、[OpenRouter Images API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation) 和 [Gemini generateContent](https://ai.google.dev/gemini-api/docs/generate-content/image-generation) — 支持的线路操作。

<a id="model-experience"></a>
## 模型体验

### 图像 API 请求

#### 模型看到的内容

供应商将消费者的 `prompt` 发送到所选图像 API，并向消费者返回可见 `text` 和图像字节。消费者负责聊天内容。

#### Token 影响

供应商不增加聊天提示词 token。图像 API 计费独立于聊天 token 测量。

#### KV Cache 影响

`image-generation-http` 供应商不修改聊天请求或其缓存前缀。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 文本生成图像请求使用供应商默认尺寸、质量和格式。
- 不支持仅 URL 响应、SVG、旧版 DALL-E 响应格式选项、图像编辑或部分图像流。
- 图像生成用量和费用不计入聊天 token meter。
- 执行时，配置的模型需要有效凭据和供应商访问权限。

<a id="dev-note"></a>
### 开发备注

无。
