---
description: "试用较小的文件读取窗口，并比较完整任务的用量、提示词缓存和工具模式。"
---

# 试用节省 token 的设置

[English](token-savings.md) | 中文

## 概述

每种挂载文件读取工具的组合都会在所有模型路由中使用 500 行的默认窗口，同时允许显式读取最多请求 2,000 行。自定义的较小行数上限也会降低默认窗口。窗口会在提供方路由前缩小输入，但各模型的 tokenizer 和读取行为会影响总 token 节省量。稳定的工作区指令可能提高提供方特定的前缀缓存复用率，而切换模型会保留对话的任务状态。

## 目录

- [试用较小的读取窗口](#try-smaller-reads)
- [按需检索大型结果](#retrieve-large-results-selectively)
- [保持可复用上下文稳定](#keep-reusable-context-stable)
- [选择工具模式](#choose-a-tool-mode)
- [衡量完整任务](#measure-the-complete-task)
- [开发备注](#dev-note)

<a id="try-smaller-reads"></a>
## 试用较小的读取窗口

文件读取工具自身拥有较小的默认值，因此 Web preset、Portal、SDK 扩展和自定义组合无需提供方特定设置即可使用它。profile 可以覆盖工具配置。[读取窗口 patch](../../apps/cli/config/examples/token-savings.patch.yml)会显式固定标准值；在仓库根目录检查此配置：

```sh
pnpm dsh --profile portal --patch "$PWD/apps/cli/config/examples/token-savings.patch.yml" --dump-config
```

确认 `tool-fs` 行包含 `readDefaultLimit: 500` 和 `readLimit: 2000`。此 patch 可省略。patch 会替换整行配置，因此请同时写入希望保留的自定义字节、单行长度或流式读取阈值。

不带 `limit` 的 `read` 调用最多返回 500 行，仍受现有字节和单行长度上限约束。调用方可以显式请求不超过 2,000 的 `limit`，也可以使用返回的续读 offset。窗口设置与模型无关；实际 token 减少量则不同，因为 tokenizer、任务行为和提供方用量统计各异。配置与校验细节由[文件系统工具](../../packages/fs/tool-fs/README.zh.md)说明。

<a id="retrieve-large-results-selectively"></a>
## 按需检索大型结果

基于 base 的 profile 将大型工具结果保留在 6,000 token 的估算预算内，包括检索提示。模型会收到结果的开头、结尾，以及完整格式化结果的文件路径。如果省略的中间内容与任务相关，请对该路径执行定向 `read` 或 `grep`。此策略保留 `read` 结果与 PTC 程序的完整值。较小的结果原样通过；检索存储失败时保留原始结果。[Spill 策略](../../packages/spill/spill-policy/README.zh.md)定义配置、图像定价与例外。

搜索结果在每个文件路径下使用紧凑的 `N: text` 行。这会删除重复标签，同时保留路径、行号与所有保留的匹配。[文件系统搜索](../../packages/fs/tool-fs-search/README.zh.md)拥有结果上限与完整列表的检索规则。

<a id="keep-reusable-context-stable"></a>
## 保持可复用上下文稳定

新对话将适用的工作区指令放在初始任务之前，使不同任务可以共享相同的指令前缀。直接用户指令仍优先于工作区指导。已有对话历史保持原有顺序；[工作区指令](../../packages/context/agent-instructions/README.zh.md)定义加载与刷新行为。

将稳定指导放在指令文件中，将变化的请求放在任务中。提供方决定可复用前缀是否产生缓存命中。切换模型会保留对话历史、目标、待办事项和检查点；它不会传输可跨模型移植的原始模型缓存，也不会因切换而自动生成摘要。请分别评估各个提供方和模型的缓存复用情况。

<a id="choose-a-tool-mode"></a>
## 选择工具模式

在相同工作负载上比较原生工具调用和程序化工具调用（PTC）。原生调用省去生成的代码 SDK 上下文；PTC 可以批量执行多个操作并在本地处理结果，但其 SDK 和程序输出也消耗上下文。选择能以更少总用量完成任务的模式，而不是仅凭可见调用次数选择。[工具模式](../../packages/core/tools/README.zh.md)说明可用配置。

<a id="measure-the-complete-task"></a>
## 衡量完整任务

在相同的代表性任务和模型路由上比较 500 行默认值与较大的显式值。还要在其他路由上重复比较，不要假设一个模型的百分比适用于其他模型。任务应包含短文件、大文件的局部读取，以及需要整个文件的情况。独立验证结果文件或答案，并比较完成时间与重试次数。

较小读取窗口的一次 DeepSeek V4.1 Flash 实测中，每种设置运行六个合成任务，提供方报告的总 token 用量减少了 49.8%。另一项 `deepseek-flash` 路由的 spill 预算实测比较 12,500 与 6,000，对三类任务分别重复三次：全部 18 份报告均符合独立核对的答案，总用量从 524,213 降至 349,116 token（减少 33.4%）。小输出任务的总用量增加了 23.7%，因为其中一次候选运行增加了验证调用。这些合成结果仅覆盖一个模型，不能确立跨模型的节省比例。分别比较每次请求中提供方报告的输入、输出和可用的缓存读取／缓存写入用量总计，包括重试、压缩（compaction）和辅助模型调用。缺失的用量字段应保持未知；token 总量不能证明计费用量下降。比较成本时使用各提供方适用的价格。只有在成功完成的完整任务有所改善且不丢失必需结果时，才保留该设置；增加的续读调用可能抵消较小窗口带来的收益。

<a id="dev-note"></a>
## 开发备注

无。
