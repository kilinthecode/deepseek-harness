---
description: "供组合显式选择图像模型的供应商无关图像生成服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-image-generation

[English](README.md) | 中文

## 概述

本包定义 `ctx.imageGeneration`：发现已配置的图像模型，准备包含显式供应商、模型和提示词的请求，并接收完整的编码栅格图像。具体供应商实现注册此服务；本包没有端点或配置。

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

先挂载 [image-generation-http](../image-generation-http/README.zh.md) 等实现，再挂载 [tool-image-generation](../tool-image-generation/README.zh.md) 等消费者。聊天模型的图像输入元数据独立存在，不授予图像生成能力。供应商在网络请求前拒绝未配置的图像模型 ID。

`prepare(request)` 为后续 `generate(signal)` 调用捕获模型选择、提示词和供应商配置。每次调用执行一次生成尝试，不自动重试。消费者先验证并持久化返回的字节，再向会话日志或模型公开图像引用。供应商文本包含可见响应文本，不包含私有推理。

<a id="understand-the-implementation"></a>
## 理解实现

抽象 `ImageGenerationProvider` 负责发现和准备。`ImageGenerationResult` 包含完整的 PNG、JPEG、WebP 或 GIF 字节以及可选文本，不包含临时 URL。供应商负责取消、凭据解析和请求限制。消费者负责附件验证和持久化结果发布。

没有运行时不变量伴随模块：抽象服务没有可独立观察并比较的状态或关系。

<a id="further-exploration"></a>
## 深入阅读

- [LLM 子系统](../../../docs/subsystems/llm-streaming.zh.md) — 图像生成类型和服务方法。
- [附件服务](../../attachment/attachment/README.zh.md) — 验证和持久引用。
- [生成图像](../../../docs/user/guide/image-generation.zh.md) — 配置和使用图像模型。

<a id="model-experience"></a>
## 模型体验

### 图像生成请求

#### 模型看到的内容

`ctx.imageGeneration` 服务不贡献提示词、工具或对话内容。消费者负责 `ImageGenerationResult` 如何进入聊天模型。

#### Token 影响

`ctx.imageGeneration` 服务本身不增加 token；消费者负责结果内容。

#### KV Cache 影响

`ctx.imageGeneration` 服务不修改聊天请求或其缓存前缀。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 请求仅支持文本生成图像。编辑、参考图像、流式部分图像以及供应商特有的质量或尺寸控制没有共享请求字段。

<a id="dev-note"></a>
### 开发备注

无。
