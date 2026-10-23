# Agent Note: 新对话的稳定指令前缀

Status: implemented

[English](2026-10-01-fresh-instruction-prefix.md) | 中文

## Problem

同一项目中不同对话的工作区指令可以相同，但若将指令放在变化的初始任务之后，共同请求前缀就会在指令文本之前结束。重排已有对话则会改变已经发给模型的输入，并丢失可复用历史。

## Decision

[指令插件](../../../../packages/context/agent-instructions/src/index.ts)仅在尚未接纳任何输入时，将完整基线消息放在初始任务之前。它使用已有的持久观测：没有请求头，没有有序消息节点，且 `contentGeneration` 为零。空 assistant 内容仍占据节点，替换会推进 generation；派生转录为空或处于第一步，都不足以证明对话尚未接纳输入。接纳前被拒绝或取消的提案会保留首次前缀，供下一个任务使用。

指令保持为带来源的 user 角色消息，保留现有框架与变更记录。已接纳的 `user/message` 顺序就是模型请求顺序；无需新增事件或独立接纳标记。已认领批次中匹配的基线会移到初始任务之前，不会增加副本。首次空输入会让指令保持待处理。

已有、恢复、继承和压缩后的历史保持原顺序。恢复的基线与后续文件变更采用追加方式。框架继续声明，工作区指引不能覆盖 system、developer 或用户直接下达的指令。[记忆快照决策](2026-09-25-frozen-memory-snapshot-and-review.zh.md)仍然独立：此新对话前缀例外仅适用于完整工作区指令基线。

## Alternatives considered

**将基线保留在初始任务之后。** 这保留此前的位置，但会阻止不同任务共享后面的指令前缀。

**将工作区指令提升为 system 角色。** 这会把仓库指引变为更高权限的内容，并让系统提示词更新行为决定其生命周期。user 角色内容已经提供所需的持久性与优先级声明。

**改写恢复或压缩后的历史。** 移动已接纳消息会改变已有请求前缀。仅追加的恢复保留早先输入，也不需要另一套回放表示。

**新增切换摘要或另一接纳标记。** 新摘要会消耗 token，并在每次切换时重复已有对话状态。新标记会重复已经能确认接纳状态的请求头与消息投影。

## Consequences

工作区、配置及前面的请求内容相同时，可以在不同任务文本之前保留更长的相同前缀。提供方的缓存适用条件仍然有效；此排序既不减少指令 token，也不保证缓存命中，更不会传输模型特定的 KV Cache。任务之后的动态上下文与模型特定序列化仍可能限制复用。

## Verification

[指令测试](../../../../packages/context/agent-instructions/tests/agent-instructions.spec.ts)固定新对话排序、匹配的待处理基线、空消息与替换历史、继承请求、取消、接纳前失败、提供方重试、压缩及后续文件变更。[真实模型 e2e](../../../../packages/context/agent-instructions/tests/agent-instructions.e2e.ts)包含用户直接覆盖冲突工作区指引的用例。[原生](../../../../snapshots/session/agent-instructions/snapshot.yml)与 [PTC](../../../../snapshots/session/ptc-workspace-context/snapshot.yml)录制固定已接纳的顺序。这些检查确认请求行为；缓存命中率与完整任务成本仍需测量。
