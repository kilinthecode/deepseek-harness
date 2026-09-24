/** Scoped model-facing room tools for the opt-in Agent Teams room runtime. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { RoomProposalId } from '@deepseek-ai/dsh-experimental-agent-team'
import type { RoomProposalView, RoomView } from '@deepseek-ai/dsh-experimental-agent-team'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-agent-room'
/** Services required by the room tool plugin. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt']

/** Room tool deployment choices. */
export interface Config {
  /** Maximum transcript entries one `room_view` result returns. */
  readonly maxTranscriptEntries?: number
}

/** Loader schema for the opt-in room tool plugin. */
export const Config: z<Config> = z.object({
  maxTranscriptEntries: z.number().step(1).min(1).default(20),
})

/** Model-facing co-accountability policy shared by every room participant. */
const POLICY = `This session is a room: several participants reason about one question together, each running its own model. You speak only when another participant or the human gives you the floor; do not assume a turn you were not given.

A decision settles only by quorum, never by one participant. room_propose puts a statement to the room. Every participant other than the proposer is a reviewer and must record a standing with room_review: approve, reject, or abstain, each with a reason. Approve only when you would defend the decision yourself. Reject when you found a specific problem, and state the problem in the reason so the proposer can act on it. Abstain when you have no basis to judge either way. A decision is accepted only when every reviewer has voted, enough of them approved, and no rejection stands, so a silent reviewer delays the room and an unexplained rejection blocks it.

A proposer cannot review its own decision. A decision that has settled is final. When reviewers reject, the proposer may carry a revised statement back with room_propose and supersedes; after the configured revision limit the decision must go to the human. Use room_escalate when the room cannot converge or the choice belongs to the human. Use room_prompt when the next useful step is another participant's judgement rather than your own, and say exactly what you want from it. Use room_view to read what the room has said and where each decision stands; re-read it after you are woken instead of relying on memory.`

const DECISION_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    proposer: { type: 'string', required: true },
    statement: { type: 'string', required: true },
    phase: { type: 'string', required: true, enum: ['open', 'accepted', 'rejected', 'escalated'] },
    requiredApprovals: { type: 'integer', required: true },
    approvals: { type: 'array', required: true, items: { type: 'string' } },
    rejections: { type: 'array', required: true, items: { type: 'string' } },
    abstentions: { type: 'array', required: true, items: { type: 'string' } },
    awaiting: { type: 'array', required: true, items: { type: 'string' } },
    standings: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reviewer: { type: 'string', required: true },
          verdict: { type: 'string', required: true, enum: ['approve', 'reject', 'abstain'] },
          reason: { type: 'string', required: true },
        },
      },
    },
  },
} as const

const PARTICIPANT_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed'] },
    model: { type: 'string' },
  },
} as const

const TRANSCRIPT_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    author: { type: 'string', required: true },
    text: { type: 'string', required: true },
  },
} as const

const ROOM_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chair: { type: 'string', required: true },
    participants: { type: 'array', required: true, items: PARTICIPANT_VIEW_SCHEMA },
    transcript: { type: 'array', required: true, items: TRANSCRIPT_VIEW_SCHEMA },
    truncated: { type: 'boolean', required: true },
    decisions: { type: 'array', required: true, items: DECISION_VIEW_SCHEMA },
  },
} as const

const PROMPT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messageId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['accepted', 'queued'] },
  },
} as const

/**
 * Declare one canonical output schema with compact model-facing JSON. Every
 * room result is a fixed record, so the declared schema is what makes the
 * compiler check `execute` against the value the model is promised.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by {@link defineTool}.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  /* v8 ignore next 2 -- room tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/** Render one decision as the compact record the model is promised. */
function decisionValue(view: RoomProposalView): InferValue<typeof DECISION_VIEW_SCHEMA> {
  return {
    id: view.id,
    revision: view.revision,
    proposer: view.proposerName,
    statement: view.statement,
    phase: view.phase,
    requiredApprovals: view.requiredApprovals,
    approvals: view.approvals,
    rejections: view.rejections,
    abstentions: view.abstentions,
    awaiting: view.awaiting,
    standings: view.standings.map(standing => ({ ...standing })),
  }
}

/** Join the text content of one transcript entry for model-facing rendering. */
function transcriptText(content: RoomView['messages'][number]['content']): string {
  return content
    .flatMap((block) => {
      /* v8 ignore next -- the room transcript records only the text blocks of an assistant message. */
      if (block.type !== 'text') return []
      return [block.text]
    })
    .join('')
}

/** Register the complete room tool set in one exact Agent scope. */
function install(agent: Agent, ctx: Context, config: Required<Config>): () => void {
  const scoped = agent.ctx
  const disposers: Array<() => unknown> = []
  const register = (disposer: () => unknown): void => { disposers.push(disposer) }
  try {
    register(scoped.systemPrompt.section({
      name: 'room:policy',
      order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: POLICY,
    }))

    register(scoped.tools.register(defineTool({
      name: 'room_view',
      description: 'Read the room roster, the recent shared transcript, and every decision with its current votes. Re-read after you are woken instead of relying on memory.',
      parameters: {
        entries: {
          type: 'integer',
          description: `Number of trailing transcript entries to return, 1 through ${config.maxTranscriptEntries}. Defaults to ${config.maxTranscriptEntries}.`,
        },
      },
      output: jsonOutput(ROOM_VIEW_SCHEMA),
      execute(args, exec) {
        const view = ctx.agentTeams.roomView(callingAgent(exec.agent, 'room_view'))
        const requested = args.entries ?? config.maxTranscriptEntries
        const count = Math.min(Math.max(requested, 1), config.maxTranscriptEntries)
        return Promise.resolve({
          chair: view.chair,
          participants: view.participants.map(participant => ({
            name: participant.name,
            status: participant.status,
            ...participant.model === undefined ? {} : { model: participant.model },
          })),
          transcript: view.messages.slice(-count).map(message => ({
            author: message.authorName,
            text: transcriptText(message.content),
          })),
          truncated: view.messages.length > count,
          decisions: view.proposals.map(decisionValue),
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'room_prompt',
      description: 'Give one participant the floor with a self-contained instruction. The target receives the transcript it has not yet seen, so say exactly what you want from it.',
      parameters: {
        target: { type: 'string', required: true, description: 'Participant name, or lead.' },
        instruction: { type: 'string', required: true, description: 'What you want that participant to do or answer.' },
      },
      output: jsonOutput(PROMPT_VALUE_SCHEMA),
      execute(args, exec) {
        return ctx.agentTeams.roomPrompt(callingAgent(exec.agent, 'room_prompt'), {
          target: args.target,
          instruction: [{ type: 'text', text: args.instruction }],
          signal: exec.signal,
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'room_propose',
      description: 'Put one statement to the room for a collective decision. Every participant other than you becomes a reviewer and must record a standing. Nothing is accepted until quorum approves without a standing rejection.',
      parameters: {
        statement: { type: 'string', required: true, description: 'The exact decision the room is asked to accept or reject.' },
        supersedes: {
          type: 'string',
          description: 'Decision id this statement replaces, when carrying a revised statement back after rejections.',
        },
      },
      output: jsonOutput(DECISION_VIEW_SCHEMA),
      async execute(args, exec) {
        const view = await ctx.agentTeams.roomPropose(callingAgent(exec.agent, 'room_propose'), {
          statement: args.statement,
          ...args.supersedes === undefined ? {} : { supersedes: RoomProposalId(args.supersedes) },
          signal: exec.signal,
        })
        return decisionValue(view)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'room_review',
      description: 'Record your standing on one decision revision. Approve only when you would defend the decision yourself; reject with the specific problem so the proposer can act on it. A proposer cannot review its own decision.',
      parameters: {
        proposal_id: { type: 'string', required: true, description: 'Decision id from room_propose or room_view.' },
        revision: { type: 'integer', required: true, description: 'Revision you are judging, exactly as room_view reports it.' },
        verdict: { type: 'string', required: true, enum: ['approve', 'reject', 'abstain'], description: 'Your standing.' },
        reason: { type: 'string', required: true, description: 'Why you chose this standing; the proposer and the human read it.' },
      },
      output: jsonOutput(DECISION_VIEW_SCHEMA),
      async execute(args, exec) {
        const view = await ctx.agentTeams.roomReview(callingAgent(exec.agent, 'room_review'), {
          proposalId: RoomProposalId(args.proposal_id),
          proposalRevision: args.revision,
          verdict: args.verdict,
          reason: args.reason,
          signal: exec.signal,
        })
        return decisionValue(view)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'room_escalate',
      description: 'Hand one unresolved decision to the human. Use it when reviewers cannot converge, the revision limit is reached, or the choice is not the room\'s to make.',
      parameters: {
        proposal_id: { type: 'string', required: true, description: 'Decision id from room_propose or room_view.' },
        reason: { type: 'string', required: true, description: 'Why the human must decide.' },
      },
      output: jsonOutput(DECISION_VIEW_SCHEMA),
      async execute(args, exec) {
        const view = await ctx.agentTeams.roomEscalate(callingAgent(exec.agent, 'room_escalate'), {
          proposalId: RoomProposalId(args.proposal_id),
          reason: args.reason,
          signal: exec.signal,
        })
        return decisionValue(view)
      },
    })))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}

/** Install room tools in every live or subsequently published room participant scope. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: Required<Config> = {
    maxTranscriptEntries: config.maxTranscriptEntries ?? 20,
  }
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return
    installed.set(agent, install(agent, ctx, resolved))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-room.scopedTools()')
}
