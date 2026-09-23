# Agent Note: Web composer 将 route 的图像能力视为提示性信息

Status: implemented

[English](2026-09-23-advisory-route-image-capability.md) | 中文

## 问题

Web composer 在每个 route 上都接受图像。只有在点击发送之后、Host 提示准入以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝提示时，它才得知所选 route 拒绝图像；当草稿中持有图像时将 Session 切换到仅支持文本的 route 没有任何警告，模型菜单也没有说明哪些模型接受图像。

## 决策

### 目录携带能力信息

当 `resolveModelInfo` 返回模型的 `inputModalities` 时，`session/modelCatalog` 的行会携带该字段，否则省略该字段。该字段仅存在于传输层；没有 Session 事件或持久化类型的变更。

### 能力被单向推入 composer

`ui-model-selection` 根据 Session 的当前选择和已加载的目录计算出一个按 Session 划分的 `boolean | null`，并将其发布到 `ctx.conversation.routeImage`——与 composer 块相同的单向通道，因此 `ui-conversation` 无需从它导入任何东西。对于已列出且仅支持文本的选择它发布 `false`，对于已列出且支持图像的选择或没有 `inputModalities` 的已列出行发布 `true`，在首次加载之前或选择未列出时发布 `null`，并在刷新出错时保留上一次的值。

### composer 只对 `false` 采取行动

当值为 `false` 时，composer 以 `image.modelUnsupported` 拒绝图像输入；当 rail 持有图像时，它在每个片段中只显示一次该文案，禁用发送按钮，并拒绝用 Enter 手势提交消息草稿。`/` 命令仍可提交，以便用 `/model` 切换回去。`null` 和 `true` 不改变 composer 的行为。Host 提示准入仍是强制执行点。模型菜单在列表包含 `image` 的行上显示 Image 说明文字。

## 考虑过的替代方案

**由 Host 投影 route 能力。** Session 投影是 Session 事件的同步折叠，而 `resolveModelInfo` 是异步的，其答案会随适配器、设置和凭据而变化。客户端已在这些事件时重新加载的目录携带了这一事实，无需第二个缓存。

**在客户端拒绝未知能力。** 将缺失的列表、未加载的目录或未列出的选择视为仅支持文本，会在 Host 允许的 route 上锁死图像输入。

**在模型菜单中加确认对话框。** 菜单看不到草稿，且 `/model` 会绕过它；composer 能观察到每一次 route 变更。

**从 `ui-model-selection` 向 `ui-conversation` 做运行时导入。** 功能插件之间不得进行运行时导入；单向推送沿用了现有的 composer 块通道。

## 影响

composer 与 Host 的分歧只会偏向放行：未知或未列出的 route 允许图像，由 Host 来裁决。用户在发送前就能看到拒绝提示，可以移除图像或切换回去。没有组合 `ui-model-selection` 的部署保持今天的行为，因为该提示性信息保持为 `null`。

## 测试

测试覆盖目录字段（`packages/api/session-controller/tests/session-models.host.spec.ts`）、提示性信息推送（`packages/client/ui-model-selection/tests`）、注册表（`packages/client/ui-conversation/tests/route-image.client.spec.ts`），以及 composer 的输入、提示、发送、Enter 和斜杠命令行为（`packages/client/ui-conversation/tests/input-bar.client.spec.tsx`）。
