/**
 * The three memory tools over `ctx.memory`. Each call needs an owning agent
 * session: its working directory selects the project scope, and a caller
 * without one has no project to write into.
 * @module @deepseek-ai/dsh-tool-memory/src/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MEMORY_SCOPES, MEMORY_TYPES } from '@deepseek-ai/dsh-memory'
import type { MemoryRecord, MemoryScope, MemoryType } from '@deepseek-ai/dsh-memory'

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'

const WRITE_DESCRIPTION = 'Save one durable memory for future sessions.'

const RECALL_DESCRIPTION = 'Read saved global memories and the current project\'s memories.'

const FORGET_DESCRIPTION = 'Delete one saved memory by name and scope.'

/** Model-facing view of one record: the stored fields without timestamps. */
interface MemoryView {
  name: string
  type: MemoryType
  scope: MemoryScope
  description: string
  content: string
}

const MEMORY_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    type: { type: 'string', required: true, enum: [...MEMORY_TYPES] },
    scope: { type: 'string', required: true, enum: [...MEMORY_SCOPES] },
    description: { type: 'string', required: true },
    content: { type: 'string', required: true },
  },
} as const

function view(record: MemoryRecord): MemoryView {
  return {
    name: record.name,
    type: record.type,
    scope: record.scope,
    description: record.description,
    content: record.content,
  }
}

function renderMemory(memory: MemoryView): string {
  return `## ${memory.name} [${memory.type}, ${memory.scope}]\n${memory.description}\n\n${memory.content}`
}

function requireAgent(exec: ToolExecution, tool: string): Agent {
  if (!exec.agent) {
    // Memories are scoped by the owning session's working directory; a caller
    // without a session has no scope to write into or read from.
    throw new Error(`${tool} requires an owning agent session`)
  }
  return exec.agent
}

function present(title: string, kind: NonNullable<GenericCallView['kind']>, rawInput: unknown): GenericCallView {
  return { card: 'generic', title, kind, rawInput }
}

/**
 * Register `memory_write`, `memory_recall`, and `memory_forget` on `ctx.tools`.
 * @param ctx - registrant context carrying `tools` and `memory`; registrations dispose with it.
 * @param maxRecallResults - most records one `memory_recall` call returns.
 */
export function registerMemoryTools(ctx: Context, maxRecallResults: number): void {
  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: WRITE_DESCRIPTION,
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Stable lowercase kebab-case identifier (1 to 64 characters), e.g. "prefers-pnpm". Writing an existing name in the same scope replaces that memory.',
      },
      type: {
        type: 'string',
        required: true,
        enum: [...MEMORY_TYPES],
        description: 'user (who the user is and how they like to work) | feedback (feedback or corrections on how to do the work) | project (a durable fact or constraint about the current project) | reference (a pointer to an external resource such as a URL, ticket, or dashboard).',
      },
      scope: {
        type: 'string',
        required: true,
        enum: [...MEMORY_SCOPES],
        description: 'project for facts about the current repository (visible in sessions inside its project root) | global for everything else (visible in every session).',
      },
      description: {
        type: 'string',
        required: true,
        description: 'One line (at most 256 characters) shown in the memory catalog; make it specific enough to decide whether to recall the memory.',
      },
      content: {
        type: 'string',
        required: true,
        description: 'The memory itself: the fact, why it matters, and how to apply it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          scope: { type: 'string', required: true, enum: [...MEMORY_SCOPES] },
          outcome: { type: 'string', required: true, enum: ['created', 'updated'] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.outcome === 'created' ? 'Saved' : 'Updated'} ${value.scope} memory "${value.name}".`,
      }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec, 'memory_write')
      const result = await ctx.memory.write({
        name: args.name,
        type: args.type,
        scope: args.scope,
        description: args.description,
        content: args.content,
        cwd: agent.session.header.cwd,
      })
      return { name: result.record.name, scope: result.record.scope, outcome: result.outcome }
    },
    presentCall: args => present('Save memory', 'other', args),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: RECALL_DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        description: 'Case-insensitive substring matched against name, description, and content. Omit to list the newest memories.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memories: { type: 'array', required: true, items: MEMORY_VIEW_SCHEMA },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.memories.length === 0
          ? 'No saved memories match.'
          : value.memories.map(renderMemory).join('\n\n'),
      }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec, 'memory_recall')
      const records = await ctx.memory.recall({
        query: args.query,
        limit: maxRecallResults,
        cwd: agent.session.header.cwd,
      })
      return { memories: records.map(view) }
    },
    presentCall: args => present('Recall memories', 'search', args),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: FORGET_DESCRIPTION,
    parameters: {
      name: { type: 'string', required: true, description: 'Name of the memory to delete.' },
      scope: { type: 'string', required: true, enum: [...MEMORY_SCOPES], description: 'Scope the memory lives in.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          scope: { type: 'string', required: true, enum: [...MEMORY_SCOPES] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Forgot ${value.scope} memory "${value.name}".` }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec, 'memory_forget')
      await ctx.memory.forget({ name: args.name, scope: args.scope, cwd: agent.session.header.cwd })
      return { name: args.name, scope: args.scope }
    },
    presentCall: args => present('Forget memory', 'other', args),
  }))
}
