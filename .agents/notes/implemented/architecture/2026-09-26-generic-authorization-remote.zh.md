# Agent Note: 通用授权 Remote

Status: implemented

[English](2026-09-26-generic-authorization-remote.md) | 中文

## Problem

[凭据记录决策](2026-08-13-credential-records-and-authorization-flows.zh.md)把提供商登录放到 `ctx.authorization` seam 之后，并把它所需的 wire 契约与模型设置页控件推迟到以后。flow 从在进程内运行它的调用方那里拿到 interaction 与 signal，而凭据存储的 Remote 描述的是记录，不是登录。任何渲染登录控件的页面都通过 Remote 访问宿主，因此模型设置页可以列出 `openai-codex` 这类路由——其 ChatGPT Plus 或 Pro 订阅登录是它唯一接受的凭据——却无法运行它的 flow、显示它给出的页面或设备码、回答它的提问、取消它或退出登录。

## Decision

`@deepseek-ai/dsh-api-authorization-controller` 在 `ctx.remote.authorization` 上挂载一个宿主 Remote，提供 `getState`、`start`、`answer`、`decline`、`cancel`、`signOut` 与 `watch`，把每个操作转发给 `ctx.authorization` 与 `ctx.credentials`。该命名空间不涉及任何提供商，也不涉及任何协议：哪个适配器拥有某种凭据格式，就由它注册 flow，[pi-ai 适配器](../../../../packages/llm/llm-pi-ai/README.zh.md)为每个自带登录的已安装目录提供商注册一个，而这七个命令既能运行 OAuth 订阅登录、交互式 api-key 提问，也能运行后续适配器注册的任何流程。

`getState` 返回每个已注册 flow 与 `ctx.credentials.describeRecord()` 所得 `configured`、`writable` 的合并结果，以及控制器自己的 attempt，因此界面一次读取就能决定「登录」「退出登录」和登录状态标签。任何方法都不返回凭据内容：视图由 `list()`、`describeRecord()` 以及 flow 自身的通知与提问构成，反向穿过 wire 的唯一值是用户输入的答案。

## 单个 attempt 与整视图流

控制器同一时间只拥有一个 attempt。`start` 为某个凭据键占用这个位置，同一个键已经在跑的 attempt 直接返回其当前状态而不新起一个，不同的键则以 `authorization/already-in-flight` 拒绝。每个会改变状态的方法都返回命令执行完毕后的完整视图，`watch` 每次变化发送一个完整视图——按订阅者合并为最新视图而不是排队发送增量——因此重新连上的界面渲染的是当前状态，而不是回放它错过的内容。flow 对应键的记录发生变化也会唤醒同一批 watcher，因为别的工具写入的记录会改变一行该显示什么。

按凭据键并发多个 attempt 推迟到有第二个界面需要时再做：seam 本身就限定每个键一个 attempt，而同一个键的两个 attempt 会是两个人回答同一个 flow 的提问。单一位置也让 attempt 视图没有歧义——界面渲染的是一个 `attempt` 字段，而不是一个还要自己挑的列表。

## 目录通告 seam 注册的登录

`LlmConfigurableProvider.authorization?: { key, required }` 的答案来自 `authorizationFor()`，也就是 `registerPiAiFlows()` 用来决定存在哪些 flow 的同一个谓词，因此界面永远不会提供一个 seam 跑不了的登录，也不会有哪个 flow 的 key 没有任何目录条目命名。`required` 恰在提供商完全不提供 api-key 认证时为真，已安装目录里只有 `openai-codex` 如此；已存 profile 会收窄路由提供的服务，但不改变这一事实，因为登录是提供商的属性。

只有 `required` 的登录才影响无密钥的行是否算可用。除 `openai-codex` 外每个已安装提供商都自带 api-key 方法，而依靠环境变量或提供商原生发现认证的路由会保留该方法，因此它报告 `required: false`，没有已存登录也保持可用；页面绝不会挡住由进程提供凭据的路由。

## 提问的中继、撤回与 attempt 的结束

每个停驻的提问都带一个由控制器铸造的 branded `AuthorizationPromptId`，因为 pi-ai 自己的 prompt 对象不是 wire 值；`answer` 与 `decline` 通过该 id 寻址：过期的 id，或 `select` 提交了该提问未提供的选项，都以 `authorization/stale-prompt` 拒绝，而不会落到下一个提问上。

flow 通过自己的 signal 撤回提问——竞速中落败的一方，例如手输代码对上浏览器回调——该提问离开视图而 attempt 继续运行，因为 flow 仍在工作；只有整个请求才落定为 `cancelled`。

`cancel` 中止该 attempt 的控制器、告知 seam，并用普通 `Error` 拒绝停驻的提问，而不是 `AuthorizationDeclinedError`，因为没有人拒绝它。在 attempt 已被取消、被替换或已被销毁之后到达的提问同样被拒绝，控制器不再拥有的 flow 的后续回调也一概被拒，因此 flow 绝不会比它的 attempt 活得更久。`decline` 与 `cancel` 在拒绝或撤回送达后立即返回，因此不断提问的 flow 无法一直占着一次 Remote 调用；终态阶段通过 `watch` 到达。失败的 attempt 发布一个短错误码——seam 失败且属于本命名空间已声明者用命名空间自己的码，否则用失败自带的码，都没有时为 `unknown`——绝不发布提供商文本或机密。

## Alternatives considered

**按提供商定制命令，例如在模型设置界面上放一个 Codex 登录方法。** 授权 seam 已经是提供商中立的，pi-ai 适配器也按提供商注册 flow，因此按提供商定制的命令只会重述 flow 注册表，并在下一种登录出现时再改一遍。

**现在就让控制器支持按凭据键并发多个 attempt。** 这是推迟而非否决：每个键一个 attempt 正是 seam 的限定，还没有第二个界面要求更多，而且排队仍要为「提问属于哪个 attempt」定策略。

**在 `getState` 里返回凭据记录，或返回提问的机密值。** 界面需要的是有无与可写性，而不是机密：视图由 `list()` 与 `describeRecord()` 构成，机密提问的答案只朝一个方向流动，即进入 flow。

**发送增量流而不是完整视图。** 漏掉变化的界面必须回放这些增量并重建状态，而完整视图让最新状态成为唯一需要渲染的东西。

**在启动 flow 的请求之外再建一个交互注册表。** 凭据记录决策已经否决过复用 `ctx.userQuestions`，同样的生命周期论证也适用于自建注册表：提问必须到达启动该 flow 的页面，并由在竞速中胜出的 flow 逐条撤回，因此交互随 attempt 一起走。

## Consequences

- 所有登录界面都通过一个命名空间抵达这些 flow，本决策交付的正是此前推迟的模型设置页控件与 wire 契约；未挂载授权 seam 的组合也不会挂载该控制器，因此无头与 ACP 宿主没有变化。
- 模型设置页依据 `configured` 与 `writable` 启用**登录**与**退出登录**，为必须登录者显示**已登录**或**未登录**，并在对话框中呈现 flow 自己的链接、设备码与提问；无密钥的 `openai-codex` 行在登录提交后才可用。
- attempt 既不持久也不共享：刷新页面会放弃登录，断连期间错过的提问永不重放，而对本控制器之外另一界面正在授权的键调用 `start` 会让该 attempt 以 `authorization/already-in-flight` 落为 `failed`，同时 flow 列表报告 `inFlight`。
- `decline` 与 `cancel` 在 flow 收尾前就返回，因此 attempt 可能短暂报告 `running` 却没有停驻的提问；在这段窗口里对同一个键再次 `start` 的界面读到的是正在撤回的 attempt，而不是新的一个。
- `signOut` 删除已注册 flow 所声明的记录，并先取消该键上的任何 attempt；对于没有 flow 声明的键，或当前提供方写不了的记录，它一律拒绝。
- `packages/api/authorization-controller/tests/controller.spec.ts` 端到端覆盖该生命周期：从 select 提问经通知到提交记录、被撤回的提问让 attempt 继续运行、decline 与 cancel 拒绝停驻的提问、被替换的 attempt 拒绝后续回调、合并的流、单一 attempt 位置、`signOut` 以及销毁。
