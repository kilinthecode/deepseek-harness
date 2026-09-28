/**
 * Shared bench for `dsh agents` verb tests. Mounts the real Agent, Session,
 * and Subagent registries — the runner's `ctx.subagents.start()` calls run
 * through the real capability checks and lifecycle, with only a scripted
 * `spawn` provider standing in for the model. `ctx.subagentWorktrees` is
 * entirely faked: the real `@deepseek-ai/dsh-subagent-worktree` service is
 * implemented in parallel and every one of its methods still throws.
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type {
  AcceptOutcome,
  AcceptWorktreeRequest,
  AttachWorkerRequest,
  CreateWorktreeRequest,
  DiscardWorktreeRequest,
  ListWorktreesRequest,
  ProvisionedWorktree,
  ResolveReviewerRequest,
  WorktreeRecord,
  WorktreeRoute,
} from '@deepseek-ai/dsh-subagent-worktree'
import { apply, Config } from '../src/index.ts'
import { internals } from '../src/runner-internals.ts'

/** Recorded calls into the faked worktrees service and the scripted subagent provider, in call order. */
export interface BenchCalls {
  worktrees: { method: string; request: unknown }[]
  subagentStart: SubagentStartRequest[]
  /** `'flush'`/`'dispose'` against the operator Agent's Session/handle, in call order. */
  operator: string[]
}

/** Per-method scripts for the faked `ctx.subagentWorktrees`; an unscripted method throws if called. */
export interface WorktreesScript {
  create?: (request: CreateWorktreeRequest) => Promise<ProvisionedWorktree> | ProvisionedWorktree
  attach?: (request: AttachWorkerRequest) => Promise<WorktreeRecord> | WorktreeRecord
  resolveReviewer?: (request: ResolveReviewerRequest) => WorktreeRoute
  accept?: (request: AcceptWorktreeRequest) => Promise<AcceptOutcome> | AcceptOutcome
  discard?: (request: DiscardWorktreeRequest) => Promise<WorktreeRecord> | WorktreeRecord
  list?: (request: ListWorktreesRequest) => Promise<WorktreeRecord[]> | WorktreeRecord[]
}

/** What one child (`spawn`) start resolves to; `dispose` defaults to a no-op recording nothing. */
export type SubagentScript = (request: SubagentStartRequest) => SubagentRun | Promise<SubagentRun>

/** Bench construction options. */
export interface BenchOptions {
  worktrees?: WorktreesScript
  subagentStart?: SubagentScript
  /** Provider-resolved cwd; defaults to the real process cwd. */
  filesystemCwd?: string
}

/** One mounted bench: the tree, recorded calls, captured output, and the runner invocation. */
export interface Bench {
  ctx: Context
  calls: BenchCalls
  output(): { out: string; err: string }
  /** Every `ctx.appExit` call observed so far, in call order; a well-behaved run makes exactly one. */
  exits: number[]
  /** Invoke the runner with `config` and await the first requested exit code. */
  run(config: Partial<Config> & Pick<Config, 'verb'>): Promise<{ code: number; out: string; err: string; exits: number[] }>
}

/** A scripted provider's capabilities: every start-time feature the runner might request. */
const SCRIPTED_CAPABILITIES = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true, cwd: true }

function unscripted(method: string): never {
  throw new Error(`agents test harness: subagentWorktrees.${method} was called without a script`)
}

/** Mount the real Agent/Session/Subagent registries around scripted worktrees and provider behavior. */
export async function bench(options: BenchOptions = {}): Promise<Bench> {
  const ctx = new Context()
  if (options.filesystemCwd !== undefined) {
    const cwd = options.filesystemCwd
    ctx.provide('fs', {
      resolve: async () => ({ targetKey: cwd, displayPath: cwd }),
      processPath: () => cwd,
    } as never)
  }
  let out = ''
  let err = ''
  const calls: BenchCalls = { worktrees: [], subagentStart: [], operator: [] }
  // Resolves once the operator Agent created for this run has been disposed;
  // `run()` awaits it so a trailing `finally` (flush + dispose, after
  // `io.exit()` already resolved `exited`) completes before returning.
  let operatorDisposed: Promise<undefined> | undefined

  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  await ctx.plugin(SubagentRuntime, {})

  // The real SessionStore has no observable flush hook; wrap its one instance
  // method so `calls.operator` records the flush the runner performs.
  const originalFlush = ctx.sessions.flush.bind(ctx.sessions)
  ctx.sessions.flush = (async (session) => {
    calls.operator.push('flush')
    return originalFlush(session)
  }) as typeof ctx.sessions.flush

  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, createOptions: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(createOptions.sessionId, {
        ...createOptions.meta === undefined ? {} : { meta: createOptions.meta },
      })
      const inbox = createInboxStub()
      const agent: Agent = {
        id: session.id,
        options: createOptions.agentOptions ?? {},
        session,
        inbox,
        status: 'idle',
        ctx: ownerCtx,
        cancel: () => {},
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        followup: () => { throw new Error('agents test harness: the operator Agent must never take a model turn') },
        steer: () => {},
        inject: () => {},
        whenIdle: () => Promise.resolve(),
      }
      await createOptions.setup?.(ownerCtx, agent)
      await ctx.agents.register(agent)
      const deferred = Promise.withResolvers<undefined>()
      operatorDisposed = deferred.promise
      return {
        agent,
        dispose: () => {
          calls.operator.push('dispose')
          deferred.resolve(undefined)
          return Promise.resolve()
        },
      }
    },
    resume(): Promise<AgentHandle> {
      return Promise.reject(new Error('agents test harness: resume is not used by dsh agents'))
    },
  })

  if (options.subagentStart !== undefined) {
    const script = options.subagentStart
    const provider: SubagentProvider = {
      name: 'spawn',
      capabilities: SCRIPTED_CAPABILITIES,
      inheritsParentContext: false,
      async start(request) {
        calls.subagentStart.push(request)
        return script(request)
      },
    }
    ctx.subagents.registerProvider(provider)
  }

  const worktreesScript = options.worktrees ?? {}
  ctx.provide('subagentWorktrees', {
    create: async (request: CreateWorktreeRequest) => {
      calls.worktrees.push({ method: 'create', request })
      return worktreesScript.create?.(request) ?? unscripted('create')
    },
    attach: async (request: AttachWorkerRequest) => {
      calls.worktrees.push({ method: 'attach', request })
      return worktreesScript.attach?.(request) ?? unscripted('attach')
    },
    resolveReviewer: (request: ResolveReviewerRequest) => {
      calls.worktrees.push({ method: 'resolveReviewer', request })
      return worktreesScript.resolveReviewer?.(request) ?? unscripted('resolveReviewer')
    },
    accept: async (request: AcceptWorktreeRequest) => {
      calls.worktrees.push({ method: 'accept', request })
      return worktreesScript.accept?.(request) ?? unscripted('accept')
    },
    discard: async (request: DiscardWorktreeRequest) => {
      calls.worktrees.push({ method: 'discard', request })
      return worktreesScript.discard?.(request) ?? unscripted('discard')
    },
    list: async (request: ListWorktreesRequest) => {
      calls.worktrees.push({ method: 'list', request })
      return worktreesScript.list?.(request) ?? unscripted('list')
    },
  } as never)

  const exits: number[] = []
  return {
    ctx,
    calls,
    exits,
    output: () => ({ out, err }),
    run: async (config) => {
      internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
      internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
      const exited = new Promise<number>((resolve) => {
        ctx.provide('appExit', (code: number) => {
          exits.push(code)
          // Only the first call settles the awaited result; later calls still
          // record into `exits` so a double exit is observable and fails a
          // test asserting `exits` has exactly one entry.
          if (exits.length === 1) resolve(code)
        })
      })
      apply(ctx, new Config({ json: false, ...config }))
      const code = await exited
      // `io.exit()` resolves `exited` before the runner's trailing `finally`
      // (flush + dispose) completes; wait for it too so a caller observing
      // `calls.operator` never races the runner's own cleanup.
      if (operatorDisposed !== undefined) await operatorDisposed
      return { code, out, err, exits }
    },
  }
}
