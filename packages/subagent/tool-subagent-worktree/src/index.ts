/**
 * Model-facing `accept_worktree`, `discard_worktree`, and `list_worktrees`
 * tools over `ctx.subagentWorktrees`. Each tool is a thin adapter: it resolves
 * the calling Agent's identity into the service's owner and base directory,
 * forwards the call, and renders the exact templates this package owns.
 * Lifecycle authority, git work, and review belong to the service.
 * @module @deepseek-ai/dsh-tool-subagent-worktree
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorktreeId } from '@deepseek-ai/dsh-subagent-worktree'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  ACCEPT_VALUE_SCHEMA,
  DISCARD_VALUE_SCHEMA,
  LIST_VALUE_SCHEMA,
  renderAcceptToolValue,
  renderDiscardToolValue,
  renderListToolValue,
  toAcceptToolValue,
  toDiscardToolValue,
  toListToolValue,
} from './values.ts'

/** Cordis plugin name. */
export const name = 'tool-subagent-worktree'
/** Services required by the worktree tool plugin. */
export const inject = ['tools', 'subagentWorktrees']

/** Recover the exact caller these tools act on behalf of. */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  if (agent === undefined) throw new Error(`${toolName} requires a calling agent (exec.agent was undefined)`)
  return agent
}

/** The caller's working directory, required to scope `list_worktrees` to one repository. */
function requireCwd(agent: Agent): string {
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new Error('list_worktrees requires a session with a working directory')
  return cwd
}

/** Register the `accept_worktree`, `discard_worktree`, and `list_worktrees` tools. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'accept_worktree',
    description:
      'Land an isolated child\'s work. The harness commits the worktree\'s changes, runs any configured checks, '
      + 'and has an independent reviewer check that exact commit; only a passing change is merged into your '
      + 'checkout. A failing review returns its findings: send them to the child with send_message, wait for it '
      + 'to finish, and accept again. Call it only after the child has finished.',
    parameters: {
      worktree_id: {
        type: 'string',
        required: true,
        description: 'The worktree id reported when the child started.',
      },
    },
    output: {
      schema: ACCEPT_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderAcceptToolValue(value) }],
    },
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'accept_worktree')
      const outcome = await ctx.subagentWorktrees.accept({
        id: brandString<WorktreeId>(args.worktree_id),
        owner: { kind: 'session', sessionId: agent.id },
        parent: agent,
        signal: exec.signal,
      })
      return toAcceptToolValue(outcome)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'discard_worktree',
    description: 'Delete an isolated child\'s worktree and its branch without merging. Its unmerged changes are lost.',
    parameters: {
      worktree_id: {
        type: 'string',
        required: true,
        description: 'The worktree id reported when the child started.',
      },
    },
    output: {
      schema: DISCARD_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderDiscardToolValue(value) }],
    },
    async execute(args, exec) {
      const agent = callingAgent(exec.agent, 'discard_worktree')
      const record = await ctx.subagentWorktrees.discard({
        id: brandString<WorktreeId>(args.worktree_id),
        owner: { kind: 'session', sessionId: agent.id },
        signal: exec.signal,
      })
      return toDiscardToolValue(record)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_worktrees',
    description: 'List the isolated worktrees you started that are still open, with each one\'s branch, state, and latest review verdict.',
    parameters: {},
    output: {
      schema: LIST_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderListToolValue(value) }],
    },
    async execute(_args, exec) {
      const agent = callingAgent(exec.agent, 'list_worktrees')
      const records = await ctx.subagentWorktrees.list({
        baseDir: requireCwd(agent),
        owner: { kind: 'session', sessionId: agent.id },
      })
      return toListToolValue(records)
    },
  }))
}
