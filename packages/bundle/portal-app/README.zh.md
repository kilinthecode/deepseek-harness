---
description: "供用户和智能体监督程序使用的 Portal 终端对话与脚本模型任务。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-portal-app

[English](README.md) | 中文

## 概述

`dsh portal` 使用已配置的模型打开终端对话。用户、Codex、Claude 和其他终端调用方使用同一个命令。传入任务参数时，程序执行一次后退出；`--json` 为自动化提供结构化输出。随附的 `portal` 配置方案在 `dsh-base` 之上包含本捆绑包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 打开 Portal

安装 CLI 后运行 `dsh portal`。在本仓库中运行 `pnpm dsh portal`。在终端中不传参数会打开对话；`/exit` 关闭对话。每个任务保留对话历史并打印 Session 标识，供后续 `--session-id` 调用使用。

```sh
dsh portal
```

欢迎界面采用[应用徽标](../../../apps/desktop/resources/icon.svg)的等轴测线框，并显示当前模型与工作目录。宽终端将图形放在详情旁边；较小的终端纵向排列，或使用紧凑标记。模型与状态界面适应可用列宽。颜色遵循终端支持情况和 `NO_COLOR`；`TERM=dumb` 与管道使用纯文本输出。禁用颜色后，标签仍可读，并在支持的终端中保留图形。

### 终端控制

使用 `/model` 打开可搜索的模型选择器。输入文字筛选，使用 Up/Down 移动，按 Enter 选择；Ctrl-C 关闭选择器。模型切换在下一任务生效并保留对话。`/models` 按提供商分组显示模型，并标记当前模型；`/reasoning` 打开当前模型公布的推理级别选择器。

| 命令 | 行为 |
|---|---|
| `/model [number \| provider model]` | 打开选择器、按目录编号选择，或指定确切模型路由。 |
| `/models [provider]` | 列出配置的模型目录，可限制为一个提供商。 |
| `/reasoning [level]` | 打开推理级别选择器，或选择已公布的级别。 |
| `/status` | 显示路由、工作目录、Session，以及有报告时上一已完成轮次的 token 数。 |
| `/session` | 显示当前 Session 标识。 |
| `/new` | 下一任务开始全新对话；已保存的 Session 仍可使用。 |
| `/resume <id>` | 下一任务继续指定的已保存 Session。 |
| `/clear` | 清除 TTY 显示，不改变对话历史。 |
| `/help` | 显示命令与键盘快捷键。 |
| `/exit` | 关闭 Portal。 |

Enter 提交任务。Ctrl-J 或行尾反斜杠加 Enter 为同一任务添加下一行；括号粘贴模式将粘贴的各行保留为同一任务。在空的续行处按 Backspace 可返回上一行。Up/Down 浏览输入历史；Tab 补全斜杠命令。任务运行期间，Escape 或 Ctrl-C 取消当前轮次并返回提示符。在空闲提示符处按 Ctrl-C 会退出 Portal。

任务运行期间，Portal 显示思考与工具活动，以及简短的工具调用和结果摘要。回答保留 Markdown 与代码文本，并使用终端强调样式。`/resume` 使用共享运行器的 [Session 接管规则](../headless/README.zh.md)，包括已记录的工作目录与独占所有权要求。

### 复用桌面端或 Web 模型

模型配置属于配置方案。`--models-from` 为本次调用从现有配置方案的用户 patch 和主目录 patch 读取保存的内置模型覆盖，不修改该配置方案，也不启动其应用。凭据仍从共享 Harness 主目录解析。显式 `--patch` 文件覆盖借用的配置。

```sh
dsh portal --models-from desktop models --json
dsh portal --models-from desktop
```

来源缺失时，启动前即报错。Portal 提供 base 默认值；不导入来源应用组合包及其中的模型更改。共享 pi-ai 适配器中声明的自定义提供商路由受支持；替换适配器插件需要单独的 Portal 配置。

### 在后台运行任务

终端监督程序可以在后台终端启动这一普通命令，并在完成后收集输出。Codex、Claude、shell 脚本和用户均可使用；Portal 无需针对调用方集成。

```sh
dsh portal --models-from desktop --provider <route> --model <id> --json "review the changes in this directory"
```

使用 `dsh portal models` 中列出的标识。`--provider` 要求同时指定 `--model`；单独的 `--model` 使用配置中的默认提供商。`--reasoning-effort <id>` 只覆盖本次调用的推理设置。路由变更会清除继承的默认推理级别。这些选项不会保存新的默认模型。

任务也可来自 stdin 或单独的 `-`。重复 `--image <path>` 可输入图片。`--json` 输出共享的[无界面事件流](../headless/README.zh.md#machine-readable-output)，其中包含 Session 标识和最终回答。任务完成时退出码为 0；失败或中止时为 1。调用方应同时检查进程状态和事件流的终结事件。

`--interactive` 在管道或没有 TTY 的后台终端中打开对话。发送任务行或斜杠命令，并保持 stdin 打开以继续交互；`/exit` 或 EOF 结束对话。此模式保留逐行脚本输入和无原始终端控制序列的纯文本输出；键盘选择器由目录列表替代。该选项不能与位置任务参数、图片或 JSON 输出组合。单次任务的 JSON 事件仍使用共享无界面运行器的格式。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

`portal` 可执行文件与 `dsh --profile portal` 使用同一个配置方案启动器。本捆绑包通过 `portalStartup` 提供解析后的选项；其运行器将单次任务交给 `dsh-headless`，并使用该包的顺序任务运行器处理终端对话。一个独占 Agent 在终端轮次之间保留历史、模型选择和持久化状态。纯渲染器格式化对话信息与 Agent 活动；终端输入负责编辑与键盘选择器。显示的外部文本会移除终端控制序列。根上下文销毁时关闭终端输入并销毁 Agent。

补丁禁用 HMR 和自动记忆审查，继承基础工具和权限策略。本包不发布运行时不变量伴随模块，因为可观察关系是终端输出、Session 持久化和进程生命周期，并通过真实 CLI 组合验证。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [CLI](../../../apps/cli/README.zh.md) — 配置方案启动与配置覆盖。
- [共享运行器](../headless/README.zh.md) — JSON 输出、图片与 Session 接管规则。
- [模型适配器](../../llm/llm-pi-ai/README.zh.md) — 提供商路由与凭据引用。

-----

<a id="model-experience"></a>
## 模型体验

通过普通用户消息和共享 Agent 模型选择安装器产生间接影响。

#### KV Cache 影响

终端保留一个 Session；选择不同模型会保留历史，但会更改提供商请求路由，因此可能无法复用缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 图片和 JSON 输出需要单次任务模式。
- 按继承的策略，缺少可用回答方时，审批请求会拒绝执行。
- 会话沿用保留共享运行器对工作目录、所有权和预设的限制。
- 模型发现列出配置的目录；不会验证凭据或保证提供商可用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
