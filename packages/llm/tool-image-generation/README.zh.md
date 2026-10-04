---
description: "持久化预览与原始文件的图像模型发现及生成工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-image-generation

[English](README.md) | 中文

## 概述

本消费者通过 `ctx.imageGeneration` 提供图像模型发现和文本生成图像功能。生成成功会返回可查看的图像附件以及可下载的原始文件。基础 bundle 包含本插件；图像供应商和附件存储可用时，工具被激活。

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

挂载 [HTTP 供应商](../image-generation-http/README.zh.md)、`ctx.tools` 和[附件存储](../../attachment/attachment-local/README.zh.md)。本插件没有配置。让代理发现图像模型，并使用显式配置的供应商和模型生成图像。设置步骤见[生成图像](../../../docs/user/guide/image-generation.zh.md)。

`list_image_models` 返回已配置的供应商、模型 ID 和显示名称。`generate_image` 要求 `provider`、`model` 和 `prompt`，拒绝缺失选择或未配置模型。[工具目录](../../../docs/tool-catalog.zh.md)维护精确 schema。

<a id="understand-the-implementation"></a>
## 理解实现

工具准备一次图像请求，接收完整响应，通过附件存储验证整批图像，并保存每个原始文件而不改变其字节。仅在存储成功后，工具才发布摘要、可选供应商文本、归一化图像预览和原始文件引用。预览归一化可能改变编码或尺寸；随附原始文件保留生成的资产。

工具结果使用现有图像和文件 block，因此会话日志保留引用，聊天记录显示图像。后续支持图像输入的聊天模型接收预览；纯文本模型接收附件描述。所有聊天模型均以文件句柄表示原始文件。通用工具展示器显示模型和提示词；共享图像图库显示结果。

没有运行时不变量伴随模块：工具注册表负责注册及其释放函数，本消费者不维护独立注册表。

<a id="further-exploration"></a>
## 深入阅读

- [图像生成服务](../image-generation/README.zh.md) — 模型选择和供应商结果。
- [附件子系统](../../../docs/subsystems/attachment.zh.md) — 归一化预览和不改动的原始文件。

<a id="model-experience"></a>
## 模型体验

### 图像生成工具 schema 与结果

#### 模型看到的内容

[`list_image_models` 和 `generate_image` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-image-generation) 描述发现功能以及显式选择 `provider`、`model` 和 `prompt`。生成会追加确定性摘要、可用时的可见供应商文本，以及每个生成图像对应的图像和文件对。工具调用和结果使用常规持久化会话路径，不注入额外系统提示词。

##### 稳定摘要示例

```markdown
Generated 1 image(s) with fixture/draw. Original files are attached.
```

#### Token 影响

工具启用时，schema 增加请求 token；`list_image_models` 结果随已配置模型增加。纯文本请求携带描述而非图像字节；支持图像输入的请求按路由增加预览输入费用。

#### KV Cache 影响

供应商或模型改变时，工具 schema 保持稳定。`generate_image` 结果追加到对话记录；配置供应商会激活工具并更改请求的工具声明。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 工具仅提供文本生成图像。
- 存储失败或取消可能留下未引用的不可变对象，但不会发布不完整成功结果。
- 重复工具调用会产生另一次计费供应商请求。
- 图像模型与聊天模型选择器分别配置。

<a id="dev-note"></a>
### 开发备注

无。
