---
description: "试用较小的文件读取窗口，并比较完整任务的用量、提示词缓存和工具模式。"
---

# 试用节省 token 的设置

[English](token-savings.md) | 中文

## 概述

当任务只需要大文件的一部分时，可使用较小的默认读取窗口。保留显式请求更大窗口的能力，并在保留设置前比较完整任务。稳定的工作区指令可以增加前缀缓存的复用机会，而切换模型会保留对话的任务状态。

## 目录

- [试用较小的读取窗口](#try-smaller-reads)
- [保持可复用上下文稳定](#keep-reusable-context-stable)
- [选择工具模式](#choose-a-tool-mode)
- [衡量完整任务](#measure-the-complete-task)
- [开发备注](#dev-note)

<a id="try-smaller-reads"></a>
## 试用较小的读取窗口

可选的[读取窗口 overlay](../../apps/cli/config/examples/token-savings.patch.yml)将试用默认值设为 500 行，同时将最大值保持为 2000 行。此设置并非适用于所有任务的节省用量建议。在仓库根目录检查组合后的 profile：

```sh
dsh --profile headless --patch "$PWD/apps/cli/config/examples/token-savings.patch.yml" --dump-config
```

确认 `tool-fs` 行包含 `readDefaultLimit: 500` 和 `readLimit: 2000`。启动所选 profile 时传入相同的 `--patch` 选项即可试用。若在 checkout 之外使用已安装的 CLI（命令行界面），请将 overlay 复制到固定位置。patch 会替换整行配置，因此请同时写入希望保留的自定义字节、单行长度或流式读取阈值。

不带 `limit` 的 `read` 调用最多返回 500 行，仍受现有字节和单行长度上限约束。调用方可以显式请求不超过 2000 的 `limit`，也可以使用返回的续读 offset。移除 overlay 会恢复 profile 自身的设置；配置与校验细节由[文件系统工具](../../packages/fs/tool-fs/README.zh.md)说明。

<a id="keep-reusable-context-stable"></a>
## 保持可复用上下文稳定

新对话将适用的工作区指令放在初始任务之前，使不同任务可以共享相同的指令前缀。直接用户指令仍优先于工作区指导。已有对话历史保持原有顺序；[工作区指令](../../packages/context/agent-instructions/README.zh.md)定义加载与刷新行为。

将稳定指导放在指令文件中，将变化的请求放在任务中。提供方决定可复用前缀是否产生缓存命中。切换模型会保留对话历史、目标、待办事项和检查点；它不会传输可跨模型移植的原始模型缓存，也不会因切换而自动生成摘要。请分别评估各个提供方和模型的缓存复用情况。

<a id="choose-a-tool-mode"></a>
## 选择工具模式

在相同工作负载上比较原生工具调用和程序化工具调用（PTC）。原生调用省去生成的代码 SDK 上下文；PTC 可以批量执行多个操作并在本地处理结果，但其 SDK 和程序输出也消耗上下文。选择能以更少总用量完成任务的模式，而不是仅凭可见调用次数选择。[工具模式](../../packages/core/tools/README.zh.md)说明可用配置。

<a id="measure-the-complete-task"></a>
## 衡量完整任务

对相同的代表性任务分别使用和不使用 overlay，并保持相同模型和推理强度设置。任务应包含短文件、大文件的局部读取，以及需要整个文件的情况。独立验证结果文件或答案，并比较完成时间与重试次数。

分别比较每次请求中提供方报告的输入、输出和可用的缓存读取／缓存写入用量总计，包括重试、压缩（compaction）和辅助模型调用。缺失的用量字段应保持未知；提示词估算不能证明计费用量下降。比较成本时使用提供方适用的价格。只有在成功完成的完整任务有所改善且不丢失必需结果时，才保留试用设置；增加的续读调用可能抵消较小窗口带来的收益。

<a id="dev-note"></a>
## 开发备注

无。
