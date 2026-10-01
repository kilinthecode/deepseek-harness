/** Scoped model-facing tools for the opt-in Agent Teams runtime. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
// `@deepseek-ai/dsh-commands` is an optional peer: name its brand in type
// position so module scope loads nothing, and brand the id with the shared helper.
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandDefinitionId, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage, ReasoningEffortId, resolveDelegationImages } from '@deepseek-ai/dsh-llm'
import type { ImageInputSupport } from '@deepseek-ai/dsh-llm'
import { parentAgentOptionsForDelegation, plainForkParentOf } from '@deepseek-ai/dsh-subagent'
import {
  hasConfiguredLlmSelection,
  hasDelegationModelRequest,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from '@deepseek-ai/dsh-tool-subagent/model-selection'
import type { DelegationModelRequest } from '@deepseek-ai/dsh-tool-subagent/model-selection'
import type {} from '@deepseek-ai/dsh-session-title'
import { TeamError, TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import type { TeamDuty, TeamMemberView } from '@deepseek-ai/dsh-experimental-agent-team'
import { applyAgentScopedTools, callingAgent, defineTool, jsonOutput, type InferValue } from '@deepseek-ai/dsh-tools'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-agent-team'
/** Services required by the Team tool plugin. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt']

/**
 * Inherited tools a teammate with one duty keeps: `all`, or only the named
 * global tools. Named tools the Lead cannot see are dropped at creation, so a
 * list never widens access, and an empty list keeps no inherited tool. The
 * teammate's own Team tools are always kept.
 */
export type DutyTools = 'all' | string[]

/** Instructions and tool access for teammates created with one duty. */
export interface DutyConfig {
  /** Model-facing instructions added to the teammate's first message. */
  readonly instructions?: string
  /** Inherited tools the teammate keeps. */
  readonly tools?: DutyTools
}

/** Tool routing and duty configuration. */
export interface Config {
  /** Continuable-subagent provider used for fresh teammates. */
  readonly freshProvider?: string
  /** Continuable-subagent provider used for completed-prefix fork teammates. */
  readonly forkProvider?: string
  /**
   * Default child route and limits for every spawned teammate; the model's
   * explicit `provider`, `model`, and `reasoning_effort` arguments override it.
   */
  readonly agentOptions?: AgentOptions
  /**
   * Instructions and tool access per duty. The keys are the fixed duty names
   * `spawn_teammate` accepts and the `/team` kickoff requests; only their values vary.
   */
  readonly duties?: DutiesConfig
}

/** Configuration of each fixed duty. */
export interface DutiesConfig {
  /**
   * Teammates that write and revise the shared task plan and verify submitted
   * work. Their default tools are the read-only inherited tools.
   */
  readonly planner?: DutyConfig
  /** Teammates that claim, implement, and submit planned tasks. They keep every inherited tool by default. */
  readonly executor?: DutyConfig
}

const PLANNER_INSTRUCTIONS = 'You plan and verify; you cannot change files or run commands. Read the workspace, then write the plan with team_task_create: one task per independently verifiable change, with blocked_by for ordering and write_scopes for the files it will touch. Revise unclaimed tasks with team_task_update edit, set_dependencies, or delete. Message the Lead when the plan is ready. When a task awaits your verdict, check the work itself in the workspace, then record approved or rejected with a reason using team_task_update action "verify".'

const EXECUTOR_INSTRUCTIONS = 'You execute planned tasks. Take a ready, unowned task with team_task_update action "claim" at its current revision, implement it within its write_scopes, then hand it over with action "submit". Do not create or verify tasks; message the planner when the plan is missing work. After a rejection, rework the task and submit it again. Take the next ready task until none is left, then report to the Lead.'

/** Read-only inherited tools a planner keeps by default. */
const PLANNER_TOOLS = ['read', 'read_image', 'grep', 'glob', 'skill', 'web_search', 'web_fetch']

function dutySchema(instructions: string, tools: DutyTools): z<DutyConfig> {
  return z.object({
    instructions: z.string().default(instructions),
    tools: z.union([z.const('all' as const), z.array(z.string())]).default(tools),
  })
}

/** Loader schema for the opt-in Team tool plugin. */
export const Config: z<Config> = z.object({
  freshProvider: z.string().default('spawn'),
  forkProvider: z.string().default('fork'),
  // Schemastery materializes an omitted object as `{}`, which would read as a
  // configured route; the explicit `undefined` default keeps omission absent.
  // `.default()` accepts only a resolved value, so `extra` writes it instead.
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId>>,
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).extra('default', undefined),
  duties: z.object({
    planner: dutySchema(PLANNER_INSTRUCTIONS, PLANNER_TOOLS),
    executor: dutySchema(EXECUTOR_INSTRUCTIONS, 'all'),
  }),
})

/** Duty configuration with every value resolved. */
interface ResolvedDuty {
  readonly instructions: string
  readonly tools: DutyTools
}

/** Plugin configuration with every value resolved. */
interface ResolvedConfig {
  readonly freshProvider: string
  readonly forkProvider: string
  readonly agentOptions?: AgentOptions
  readonly duties: Readonly<Record<TeamDuty, ResolvedDuty>>
}

/**
 * Fill omitted values with the schema defaults, which a direct `apply()`
 * bypasses, and refuse blank duty instructions at load.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const duty = (name: TeamDuty, value: DutyConfig | undefined, instructions: string, tools: DutyTools): ResolvedDuty => {
    const resolved = { instructions: value?.instructions ?? instructions, tools: value?.tools ?? tools }
    if (resolved.instructions.trim().length === 0) {
      throw new Error(`tool-agent-team: duties.${name}.instructions must be non-empty`)
    }
    return resolved
  }
  return {
    freshProvider: config.freshProvider ?? 'spawn',
    forkProvider: config.forkProvider ?? 'fork',
    duties: {
      planner: duty('planner', config.duties?.planner, PLANNER_INSTRUCTIONS, PLANNER_TOOLS),
      executor: duty('executor', config.duties?.executor, EXECUTOR_INSTRUCTIONS, 'all'),
    },
    ...config.agentOptions === undefined ? {} : { agentOptions: config.agentOptions },
  }
}

/**
 * Restrict a dutied teammate to the configured inherited tools the Lead can
 * see, so a configured name never widens what the child could reach.
 */
function dutyToolFilter(ctx: Context, lead: Agent, tools: DutyTools): ToolRestriction | undefined {
  if (tools === 'all') return undefined
  return { allow: tools.filter(tool => ctx.tools.get(tool, lead) !== undefined) }
}

/**
 * Policy paragraph shared by every member of a Team with a subject. It names
 * the subject and the flow the Lead runs for it.
 */
function subjectPolicy(subject: string): string {
  return `The user started this Agent Team with the subject "${subject}". The Lead runs the plan-then-execute flow: spawn one teammate with duty "planner" to write the plan as shared tasks; when the planner reports the plan, spawn teammates with duty "executor" to claim ready tasks, implement them, and submit them; the planner verifies each submission. The Lead waits for the required teammates, then answers the user when every task is completed.`
}

/** Model-facing collaboration guidance shared by Lead and teammates. */
const POLICY = `Agent Teams is available in this session, but create teammates only when the user explicitly asks to use Agent Teams or teammates.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

Use the target returned by spawn_teammate or list_agents for send_message and interrupt_agent, or as owner when assigning or filtering shared tasks. send_message steers a running target at its nearest step boundary and starts or resumes an inactive target. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. provisioning means member creation is in progress; failed means member creation failed. A delivered peer item starts with its stable message id and sender name. A successful send is already durable even when its result says queued; do not resend it. Shared-task workflow is list, get, claim with the current revision, perform the work, then submit it. Only another member's verify verdict completes the task or returns it with the objection; judge a peer's submission against the work itself, not its report. Task readiness never starts an owner. Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when the required member is inactive. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member can produce a change. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.`

const ACTIVE_WAIT_STATUSES: ReadonlySet<TeamMemberView['status']> = new Set(['running', 'provisioning'])
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.'

/**
 * One model-facing roster row. The Lead pseudo-row omits the
 * teammate-only provisioning fields, so only identity, role, status, and
 * diagnostics are required.
 */
const MEMBER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string', required: true },
    role: { type: 'string', required: true, enum: ['lead', 'teammate'] },
    status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed'] },
    description: { type: 'string' },
    provider: { type: 'string' },
    context: { type: 'string', enum: ['fresh', 'fork'] },
    duty: { type: 'string', enum: ['planner', 'executor'] },
    model: { type: 'string' },
    acceptsImages: { type: 'string', enum: ['supported', 'unsupported', 'undeclared'] },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** One `list_agents` result row: the roster view plus listing-time image-input support. */
type ListedMember = TeamMemberView & { acceptsImages?: ImageInputSupport }

/** Expose the member name as its model-facing target. */
function modelMember(member: TeamMemberView): InferValue<typeof MEMBER_VIEW_SCHEMA> {
  const { id: _id, name, ...details } = member
  return { target: name, ...details }
}

/** One shared task, matching the public `TeamTaskView`. */
const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    subject: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'verifying', 'completed', 'deleted'] },
    ownerName: { type: 'string' },
    blockedBy: { type: 'array', required: true, items: { type: 'string' } },
    writeScopes: { type: 'array', required: true, items: { type: 'string' } },
    ready: { type: 'boolean', required: true },
    writeScopeWarnings: { type: 'array', required: true, items: { type: 'string' } },
    verification: {
      type: 'object',
      additionalProperties: false,
      properties: {
        submittedRevision: { type: 'integer', required: true },
        verifierName: { type: 'string' },
        verdict: { type: 'string', enum: ['approved', 'rejected'] },
        reason: { type: 'string' },
      },
    },
  },
} as const

const SPAWN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    member: { ...MEMBER_VIEW_SCHEMA, required: true },
  },
} as const

const MEMBER_LIST_VALUE_SCHEMA = { type: 'array', items: MEMBER_VIEW_SCHEMA } as const

const SEND_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messageId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['accepted', 'queued'] },
  },
} as const

/** `noProgress` is present only on the model-only shortcut that skips the wait. */
const WAIT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    timedOut: { type: 'boolean', required: true },
    noProgress: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', required: true, const: 'no-active-peer' },
        message: { type: 'string', required: true },
      },
    },
  },
} as const

const INTERRUPT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    previousStatus: { type: 'string', required: true, enum: ['running', 'inactive'] },
  },
} as const

const TASK_LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: { type: 'array', required: true, items: TASK_VIEW_SCHEMA },
    nextCursor: { type: 'integer' },
  },
} as const

/** Compose a teammate's first-message reminder: its identity, then its duty instructions when it has a duty. */
function teammateReminder(name: string, duty: TeamDuty | undefined, config: ResolvedConfig): string {
  const lines = [
    `You are teammate "${name}".`,
    'Your Team Lead is named "lead".',
    'Use list_agents({}) to find your teammates and their names.',
    'To message your Team Lead, use send_message({ target: "lead", message: "..." }).',
    'To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).',
    ...duty === undefined ? [] : [`Your duty is "${duty}".`, config.duties[duty].instructions],
  ]
  return `<system-reminder>\n${lines.join('\n')}\n</system-reminder>\n\n`
}

/** Register the complete Team tool set in one exact Agent scope. */
function install(agent: Agent, ctx: Context, config: ResolvedConfig): () => void {
  const scoped = agent.ctx
  const configuredRoute = config.agentOptions?.provider !== undefined && config.agentOptions.model !== undefined
    ? { route: `${config.agentOptions.provider}/${config.agentOptions.model}`, model: config.agentOptions.model }
    : undefined
  // oxlint-disable-next-line typescript/no-misused-promises -- Cordis effect generators collect yielded disposers synchronously.
  return scoped.effect(function* () {
    yield scoped.systemPrompt.section({
      name: 'team:policy',
      order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
      // Every member of one Team reads the same subject, so the section stays
      // uniform across the Lead and its fork teammates.
      text: () => {
        const subject = ctx.agentTeams.subjectOf(agent)
        return subject === undefined ? POLICY : `${POLICY}\n\n${subjectPolicy(subject)}`
      },
    })

    yield scoped.tools.register(defineTool({
      name: 'spawn_teammate',
      description: 'Create one named, durable teammate. Only the Team Lead may call this tool.',
      parameters: {
        name: { type: 'string', required: true, description: 'Unique lower-kebab-case teammate name.' },
        description: { type: 'string', required: true, description: 'Short description of the delegated responsibility.' },
        prompt: { type: 'string', required: true, description: 'Complete initial task for the teammate.' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Attachment ids of images already shown in this conversation, appended to the prompt.',
        },
        context: {
          type: 'string',
          enum: ['fresh', 'fork'],
          description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
        },
        provider: {
          type: 'string',
          description: configuredRoute === undefined
            ? 'Model provider route for this teammate, for example deepseek-official. Defaults to your own route.'
            : `Model provider route for this teammate, for example deepseek-official. Defaults to ${configuredRoute.route}.`,
        },
        model: {
          type: 'string',
          description: configuredRoute === undefined
            ? 'Model id for this teammate; pick one that fits its responsibility, since teammates on different models disagree more usefully than copies of one model. Defaults to your own model.'
            : `Model id for this teammate; pick one that fits its responsibility, since teammates on different models disagree more usefully than copies of one model. Defaults to ${configuredRoute.model}.`,
        },
        reasoning_effort: {
          type: 'string',
          description: config.agentOptions?.reasoningEffort === undefined
            ? 'Reasoning effort for this teammate, named as the target model declares it. Defaults to your own setting.'
            : `Reasoning effort for this teammate, named as the target model declares it. Defaults to ${config.agentOptions.reasoningEffort}.`,
        },
        duty: {
          type: 'string',
          enum: ['planner', 'executor'],
          description: 'planner writes and revises the shared task plan and verifies submitted work; executor claims ready tasks, implements them, and submits them. Omit for a teammate without a duty.',
        },
      },
      output: jsonOutput(SPAWN_VALUE_SCHEMA),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'spawn_teammate')
        const imageBlocks = resolveDelegationImages(
          agent.session.deriveMessages(),
          args.images,
          ctx.get('attachments')?.imageLimits.maxImagesPerMessage,
        )
        const modelRequest = args as DelegationModelRequest
        const parentOptions = parentAgentOptionsForDelegation(agent)
        const requiresRoutePreflight = hasDelegationModelRequest(modelRequest)
          || hasConfiguredLlmSelection(config.agentOptions)
        // Agent Teams has no settings-owned route allowlist, so model-facing
        // selection is always enabled; no assertAllowedModelSelection here.
        const requestedChildAgentOptions = requestedAgentOptions(
          parentOptions,
          config.agentOptions,
          modelRequest,
          true,
        )
        if (requiresRoutePreflight) {
          const llm = scoped.get('llm')
          if (llm === undefined) {
            throw new Error('cannot resolve the selected child LLM route because the `llm` service is unavailable')
          }
          await preflightChildLlmRoute(llm, parentOptions, requestedChildAgentOptions, exec.signal)
        }
        const context = args.context ?? 'fresh'
        const duty = args.duty
        const toolFilter = duty === undefined ? undefined : dutyToolFilter(ctx, agent, config.duties[duty].tools)
        const result = await ctx.agentTeams.spawnTeammate(agent, {
          name: args.name,
          description: args.description,
          prompt: [
            { type: 'text', text: teammateReminder(args.name.trim(), duty, config) },
            { type: 'text', text: args.prompt },
            ...imageBlocks,
          ],
          context,
          provider: context === 'fork' ? config.forkProvider : config.freshProvider,
          ...requestedChildAgentOptions === undefined ? {} : { agentOptions: requestedChildAgentOptions },
          ...duty === undefined ? {} : { duty },
          ...toolFilter === undefined ? {} : { toolFilter },
          signal: exec.signal,
        })
        return { member: modelMember(result.member) }
      },
    }))

    yield scoped.tools.register(defineTool({
      name: 'send_message',
      description: 'Send one durable message to another Team member. A running target receives it at the nearest step boundary; an inactive target starts or resumes a turn.',
      parameters: {
        target: { type: 'string', required: true, description: 'Member target returned by spawn_teammate or list_agents, including lead.' },
        message: { type: 'string', required: true, description: 'Self-contained message for the target.' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Attachment ids of images already shown in this conversation, appended to the message.',
        },
      },
      output: jsonOutput(SEND_VALUE_SCHEMA),
      execute(args, exec) {
        const agent = callingAgent(exec.agent, 'send_message')
        return ctx.agentTeams.sendMessage(agent, {
          target: args.target,
          content: [{ type: 'text', text: args.message }, ...resolveDelegationImages(
            agent.session.deriveMessages(),
            args.images,
            ctx.get('attachments')?.imageLimits.maxImagesPerMessage,
          )],
          signal: exec.signal,
        })
      },
    }))

    yield scoped.tools.register(defineTool({
      name: 'list_agents',
      description: 'List the Lead and every durable teammate with an addressable target, current availability, and image-input support. inactive means no turn is executing, not a task result. provisioning and failed describe member creation.',
      parameters: {},
      output: jsonOutput(MEMBER_LIST_VALUE_SCHEMA),
      async execute(_args, exec) {
        const caller = callingAgent(exec.agent, 'list_agents')
        const members = ctx.agentTeams.listMembers(caller)
        const imageSupport = await ctx.agentTeams.resolveMemberImageSupport(caller, exec.signal)
        return members.map((member) => {
          const view = modelMember(member)
          const acceptsImages: ListedMember['acceptsImages'] = imageSupport.get(member.id)
          return acceptsImages === undefined ? view : { ...view, acceptsImages }
        })
      },
    }))

    yield scoped.tools.register(defineTool({
      name: 'wait_agent',
      description: 'Wait for the next teammate status, mailbox, or shared-task change after this call starts. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling.',
      parameters: {
        timeout_ms: {
          type: 'integer',
          description: 'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.',
        },
      },
      output: jsonOutput(WAIT_VALUE_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'wait_agent')
        const timeoutMs = args.timeout_ms ?? 30_000
        // Preserve TeamService's authoritative timeout validation before the
        // model-only no-progress shortcut.
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
          return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
        }
        // The active-peer read and waiter registration must remain one synchronous
        // span; awaiting between them can lose the only peer-status edge.
        const hasActivePeer = ctx.agentTeams.listMembers(caller).some(member =>
          member.id !== caller.id && ACTIVE_WAIT_STATUSES.has(member.status))
        if (!hasActivePeer) {
          return {
            timedOut: false,
            noProgress: {
              reason: 'no-active-peer' as const,
              message: NO_ACTIVE_PEER_MESSAGE,
            },
          }
        }
        return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
      },
    }))

    yield scoped.tools.register(defineTool({
      name: 'interrupt_agent',
      description: 'Interrupt one teammate\'s current turn while preserving its pending inbox. Team Lead only.',
      parameters: {
        target: { type: 'string', required: true, description: 'Teammate target returned by spawn_teammate or list_agents.' },
      },
      output: jsonOutput(INTERRUPT_VALUE_SCHEMA),
      execute(args, exec) {
        return Promise.resolve(ctx.agentTeams.interrupt(callingAgent(exec.agent, 'interrupt_agent'), args.target))
      },
    }))

    yield scoped.tools.register(defineTool({
      name: 'team_task_create',
      description: 'Create one unowned pending task on the shared Team task board.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Concise task title.' },
        description: { type: 'string', required: true, description: 'Complete task details and acceptance criteria.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first.' },
        write_scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Advisory workspace-relative file or directory prefixes this task expects to modify.',
        },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return await ctx.agentTeams.createTask(callingAgent(exec.agent, 'team_task_create'), {
          subject: args.subject,
          description: args.description,
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
        })
      },
    }))

    yield scoped.tools.register(defineTool({
      name: 'team_task_list',
      description: 'List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.',
      parameters: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'verifying', 'completed'],
          description: 'Optional exact status filter.',
        },
        owner: { type: 'string', description: 'Optional member target from spawn_teammate or list_agents, matching ownerName; use unowned for tasks without an owner.' },
        ready: { type: 'boolean', description: 'Optional readiness filter.' },
        cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
        limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
      },
      output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
      execute(args, exec) {
        const status = args.status
        const filtered = ctx.agentTeams.listTasks(callingAgent(exec.agent, 'team_task_list')).filter(task =>
          (status === undefined || task.status === status)
          && (args.owner === undefined || (args.owner === 'unowned' ? task.ownerName === undefined : task.ownerName === args.owner))
          && (args.ready === undefined || task.ready === args.ready))
        const cursor = args.cursor ?? 0
        const limit = args.limit ?? 50
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer')
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100')
        return Promise.resolve({
          tasks: filtered.slice(cursor, cursor + limit),
          ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
        })
      },
    }))

    yield scoped.tools.register(defineTool({
      name: 'team_task_get',
      description: 'Read the complete latest value of one shared task before changing or executing it.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return Promise.resolve(ctx.agentTeams.getTask(
          callingAgent(exec.agent, 'team_task_get'),
          TeamTaskId(args.task_id),
        ))
      },
    }))

    yield scoped.tools.register(defineTool({
      name: 'team_task_update',
      description: 'Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
        expected_revision: { type: 'integer', required: true, description: 'Current task revision used as the CAS precondition.' },
        action: {
          type: 'string',
          required: true,
          enum: ['claim', 'release', 'edit', 'set_dependencies', 'submit', 'verify', 'reopen', 'reassign', 'delete'],
          description: 'Task transition to apply. submit hands your own finished work to a peer; verify records a peer verdict on submitted work.',
        },
        subject: { type: 'string', description: 'Replacement title for edit.' },
        description: { type: 'string', description: 'Replacement details for edit.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Complete blocker list for set_dependencies.' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Replacement advisory write scopes for edit.' },
        owner: { type: 'string', description: 'Member target from spawn_teammate or list_agents for Lead-only reassign; omit to unassign.' },
        verdict: { type: 'string', enum: ['approved', 'rejected'], description: 'Peer verdict required by verify.' },
        reason: { type: 'string', description: 'Why the peer approved or rejected; required by verify and read by the owner.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return await ctx.agentTeams.updateTask(callingAgent(exec.agent, 'team_task_update'), {
          taskId: TeamTaskId(args.task_id),
          expectedRevision: args.expected_revision,
          action: args.action,
          ...args.subject === undefined ? {} : { subject: args.subject },
          ...args.description === undefined ? {} : { description: args.description },
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
          ...args.owner === undefined ? {} : { owner: args.owner },
          ...args.verdict === undefined ? {} : { verdict: args.verdict },
          ...args.reason === undefined ? {} : { reason: args.reason },
        })
      },
    }))
  }, 'tool-team.agentScope()')
}

/**
 * Start an Agent Team on one subject: record it, which adds the subject policy
 * to every member's Team section, name the conversation after it, and wake the
 * Lead with the subject as the user's message.
 */
async function startTeam(ctx: Context, agent: Agent, rawInput: string): Promise<CommandResult> {
  const subject = rawInput.trim()
  if (subject.length === 0) return { kind: 'error', text: 'Usage: /team <subject>' }
  if (ctx.agentTeams.tryMembership(agent)?.role !== 'lead') {
    return { kind: 'error', text: 'Only the Team Lead conversation can start an Agent Team.' }
  }
  const titles = ctx.get('sessionTitle')
  if (titles === undefined) {
    return { kind: 'error', text: '/team needs the session-title service to name the conversation.' }
  }
  try {
    await ctx.agentTeams.setSubject(agent, subject)
  } catch (error: unknown) {
    if (error instanceof TeamError) return { kind: 'error', text: error.message }
    throw error
  }
  titles.rename(agent.session, subject)
  agent.steer(createUserMessage({ content: [{ type: 'text', text: subject }], source: { kind: 'user' } }))
  return { kind: 'success', text: 'Agent Team started.' }
}

/**
 * Whether `agent` qualifies for the Team section and tool set: either it
 * currently has Team membership itself, or walking its plain-fork lineage
 * ({@link plainForkParentOf}, applied repeatedly) reaches an agent that
 * currently does. Every agent on that lineage is a plain fork and not itself
 * a member — `spawn_teammate`/`send_message`/etc. still resolve and
 * authorize the calling agent through `ctx.agentTeams` at execution time and
 * reject a non-member with `TEAM_NOT_MEMBER`, so no fork in the lineage can
 * ever act as its ancestor — but its assembled prompt must match its
 * immediate parent's declared section and tools, and therefore transitively
 * the member's, so a provider prompt cache keyed on the exact prefix covers
 * the inherited history instead of missing on a dropped section.
 * @param agent - the exact live candidate agent.
 * @param ctx - the context whose `agentTeams` resolves membership.
 * @returns whether `agent` qualifies for the Team installation.
 */
function qualifiesForTeamInstall(agent: Agent, ctx: Context): boolean {
  const visited = new Set<Agent>()
  let candidate: Agent | undefined = agent
  while (candidate !== undefined) {
    // Defensive only: plainForkParentOf walks toward an earlier-created
    // ancestor session, so this lineage cannot cycle in practice.
    /* v8 ignore next -- guards a defect elsewhere, not a reachable case. */
    if (visited.has(candidate)) return false
    if (ctx.agentTeams.tryMembership(candidate) !== undefined) return true
    visited.add(candidate)
    candidate = plainForkParentOf(candidate)
  }
  return false
}

/**
 * Install Team tools in every live or subsequently published Team member scope
 * and in each plain fork whose fork chain reaches a live member.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  // The command activates only when a command registry is composed.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-experimental-tool-agent-team/team'),
      name: 'team',
      description: 'Start an Agent Team with a planner and executors for a subject',
      input: { hint: 'subject' },
      handler: ({ agent, rawInput }) => startTeam(ctx, agent, rawInput),
    })
  })
  applyAgentScopedTools(
    ctx,
    agent => qualifiesForTeamInstall(agent, ctx),
    agent => install(agent, ctx, resolved),
    'tool-team.scopedTools()',
  )
}
