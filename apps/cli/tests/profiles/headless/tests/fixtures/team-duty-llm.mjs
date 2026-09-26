/** Deterministic keyless adapter that runs one planner/executor Team through the shipped Agent Teams bundle. */

import { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

/** Inherited tools a planner must never see. */
const WRITE_TOOLS = ['write', 'edit', 'bash', 'pwsh', 'workflow']

let nextCall = 0

function toolCalls(messages) {
  return messages.flatMap(message => message.role === 'assistant'
    ? message.content.filter(block => block.type === 'tool-call')
    : [])
}

function callsNamed(messages, name) {
  return toolCalls(messages).filter(block => block.name === name)
}

function taskActions(messages, action) {
  return callsNamed(messages, 'team_task_update').filter((block) => {
    try {
      return JSON.parse(block.arguments).action === action
    } catch {
      return false
    }
  })
}

function latestAssistantCalls(messages) {
  const assistant = messages.findLast(message => message.role === 'assistant')
  return assistant?.content.filter(block => block.type === 'tool-call').map(block => block.name) ?? []
}

function latestToolText(messages) {
  const message = messages.findLast(candidate => candidate.role === 'tool')
  if (message === undefined) return ''
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** Every user-role text, including delivered Team messages and notices. */
function inbox(messages) {
  return messages.flatMap(message => message.role === 'user'
    ? message.content.filter(block => block.type === 'text').map(block => block.text)
    : []).join('\n')
}

function toolChunks(specs) {
  const chunks = []
  for (const [index, spec] of specs.entries()) {
    const id = ToolCallId(`team-duty-fixture-${++nextCall}`)
    const args = JSON.stringify(spec.args)
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name: spec.name, argumentsDelta: args },
      { type: 'block-end', index, block: { type: 'tool-call', id, name: spec.name, arguments: args } },
    )
  }
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function planner(messages, tools) {
  const visible = WRITE_TOOLS.filter(name => tools.includes(name))
  if (visible.length > 0 || !tools.includes('read')) {
    throw new Error(`planner sees the wrong inherited tools: ${tools.join(', ')}`)
  }
  const created = callsNamed(messages, 'team_task_create').length
  if (created === 0) {
    return toolChunks([{ name: 'team_task_create', args: {
      subject: 'Greeting', description: 'Add the greeting.', write_scopes: ['greeting'],
    } }])
  }
  if (created === 1) {
    return toolChunks([{ name: 'team_task_create', args: {
      subject: 'Farewell', description: 'Add the farewell after the greeting.', blocked_by: ['task-1'], write_scopes: ['farewell'],
    } }])
  }
  if (callsNamed(messages, 'send_message').length === 0) {
    return toolChunks([{ name: 'send_message', args: { target: 'lead', message: 'PLAN_READY: task-1, then task-2.' } }])
  }
  // Each submission reaches the planner as a notice naming the revision to judge.
  const requested = [...inbox(messages).matchAll(/Team task (task-\d+) \(revision (\d+)\) awaits your verdict/gu)]
  const verified = new Set(taskActions(messages, 'verify').map(block => JSON.parse(block.arguments).task_id))
  const next = requested.find(match => !verified.has(match[1]))
  if (next !== undefined) {
    return toolChunks([{ name: 'team_task_update', args: {
      task_id: next[1], expected_revision: Number(next[2]), action: 'verify', verdict: 'approved',
      reason: `${next[1]} delivers what the plan asked for`,
    } }])
  }
  return textChunks('Planner is waiting for submissions.')
}

function executor(messages, tools) {
  if (!tools.includes('write') || !tools.includes('read')) {
    throw new Error(`executor lost inherited tools: ${tools.join(', ')}`)
  }
  const claimed = taskActions(messages, 'claim').map(block => JSON.parse(block.arguments).task_id)
  const submitted = taskActions(messages, 'submit').length
  const approved = [...inbox(messages).matchAll(/was approved by planner/gu)].length
  if (claimed.length > submitted) {
    return toolChunks([{ name: 'team_task_update', args: {
      task_id: claimed.at(-1), expected_revision: 2, action: 'submit',
    } }])
  }
  if (submitted > approved) return toolChunks([{ name: 'wait_agent', args: { timeout_ms: 10000 } }])
  if (approved === 2) {
    if (callsNamed(messages, 'send_message').length === 0) {
      return toolChunks([{ name: 'send_message', args: { target: 'lead', message: 'ALL_DONE: both tasks approved.' } }])
    }
    return textChunks('Executor finished every planned task.')
  }
  if (latestAssistantCalls(messages).includes('team_task_list')) {
    const ready = /"id":"(task-\d+)"/u.exec(latestToolText(messages))
    if (ready !== null) {
      return toolChunks([{ name: 'team_task_update', args: { task_id: ready[1], expected_revision: 1, action: 'claim' } }])
    }
    return toolChunks([{ name: 'wait_agent', args: { timeout_ms: 10000 } }])
  }
  return toolChunks([{ name: 'team_task_list', args: { status: 'pending', ready: true } }])
}

function lead(messages) {
  const spawned = callsNamed(messages, 'spawn_teammate').length
  if (spawned === 0) {
    return toolChunks([{ name: 'spawn_teammate', args: {
      name: 'planner', description: 'Plan the greeting work.', prompt: 'Plan the greeting and farewell.', duty: 'planner',
    } }])
  }
  const last = latestAssistantCalls(messages)
  const result = latestToolText(messages)
  if (spawned === 1) {
    if (!inbox(messages).includes('PLAN_READY')) return toolChunks([{ name: 'wait_agent', args: { timeout_ms: 10000 } }])
    return toolChunks([{ name: 'spawn_teammate', args: {
      name: 'builder', description: 'Execute the planned tasks.', prompt: 'Complete every ready task.', duty: 'executor',
    } }])
  }
  if (last.includes('team_task_list') && (result.match(/"status":"completed"/gu)?.length ?? 0) >= 2) {
    return textChunks('TEAM_PLAN_EXECUTE_OK: the planner planned and verified, the executor delivered both tasks.')
  }
  if (last.includes('wait_agent')) return toolChunks([{ name: 'team_task_list', args: {} }])
  return toolChunks([{ name: 'wait_agent', args: { timeout_ms: 10000 } }])
}

class TeamDutyFixtureAdapter extends LlmAdapter {
  async * stream(options) {
    const tools = options.tools.map(tool => tool.name)
    const initial = options.messages.find(message => message.role === 'user' && message.source.kind === 'user')
    const identity = initial?.content[0]?.text ?? ''
    const chunks = identity.includes('Your duty is "planner".')
      ? planner(options.messages, tools)
      : identity.includes('Your duty is "executor".')
        ? executor(options.messages, tools)
        : lead(options.messages)
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

/** Cordis plugin name. */
export const name = 'team-duty-fixture-llm'
/** LLM registry dependency. */
export const inject = ['llm']

/** Register the keyless adapter on the shipped default provider route. */
export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new TeamDutyFixtureAdapter())
}
