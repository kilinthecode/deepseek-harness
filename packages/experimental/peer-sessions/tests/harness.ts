/**
 * Real-composition fixture for peer-session tests.
 *
 * Each harness mounts the production AgentLoop, session store, projection
 * registry, JSONL persistence, the real title projection, and `PeerService`
 * over one temp `DSH_HOME`, so `Agent.steer`, `agent/created`,
 * `user/message` appends, and every projection under test are the shipped
 * implementations rather than stubs.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent, AgentHandle, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionLogOffset, UserMessage } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import PeerService, { type Config } from '../src/index.ts'
import { mailShardDirectory, presenceDirectory, watchShardDirectory } from '../src/paths.ts'

/** One mock model response: a plain text reply, a hang, or a custom chunk list. */
type ScriptEntry = ConstructorParameters<typeof MockAdapter>[0][number]

/** Session metadata a peer test may set beyond the working directory. */
type PeerMeta = NonNullable<CreateAgentOptions['meta']>

/** How to create one agent in a harness context. */
export interface PeerAgentOptions {
  /** Working directory of a fresh session; omit for the harness workdir, pass `null` for no cwd at all. */
  readonly cwd?: string | null
  /** Extra session metadata, merged over `cwd`. */
  readonly meta?: Omit<PeerMeta, 'cwd'>
  /** Model options of the fresh session; omit for the mock provider and model. */
  readonly agentOptions?: AgentOptions
  /** Inherited log prefix; requires `inheritedEventCount`. */
  readonly seed?: readonly SessionEvent[]
  /** Fork-inherited prefix length that pairs with `seed`. */
  readonly inheritedEventCount?: SessionLogOffset
}

/** Mount options for {@link mountPeerHarness}. */
export interface PeerHarnessOptions {
  /** Peer-service configuration; every omitted field takes its shipped value. */
  readonly peer?: Config
  /** Model responses in call order; the default script always answers with text. */
  readonly script?: readonly ScriptEntry[]
  /** Reuse an existing Harness home instead of a fresh one, to model a second process on one home. */
  readonly home?: string
}

/** One mounted real-composition peer-session fixture. */
export interface PeerHarness {
  /** Root context owning every mounted service. */
  readonly ctx: Context
  /** Temp `DSH_HOME` the peer service writes under. */
  readonly home: string
  /** Default workspace directory for created agents. */
  readonly workdir: string
  /** Adapter the mock provider resolves to. */
  readonly adapter: MockAdapter
  /** Create one live agent in this context. */
  create(id: string, options?: PeerAgentOptions): Promise<Agent>
  /** Create one live agent and keep its handle, so a test can dispose just that agent. */
  createHandle(id: string, options?: PeerAgentOptions): Promise<AgentHandle>
  /** Create an extra workspace directory under the harness temp root. */
  makeDirectory(name: string): Promise<string>
  /** Write one raw envelope file into a target's mailbox shard, creating the shard. */
  plantMail(targetId: string, filename: string, content: string): Promise<string>
  /** Absolute paths of every file in a target's mailbox shard. */
  mailFiles(targetId: string): Promise<readonly string[]>
  /** Absolute paths of every file in a target's watch shard. */
  watchFiles(targetId: string): Promise<readonly string[]>
  /** Every committed event of one agent's session. */
  events(agent: Agent): readonly SessionEvent[]
  /** Every `user/message` one agent's session committed. */
  userMessages(agent: Agent): readonly UserMessage[]
  /** Every message pending in one agent's inbox, read through the inbox projection. */
  pending(agent: Agent): readonly UserMessage[]
  /** Dispose the context and remove the temp tree. */
  dispose(): Promise<void>
}

/** Model responses for `count` turns, so a default script never runs out. */
export function textScript(count: number): readonly ScriptEntry[] {
  return Array.from({ length: count }, () => textResponse('ok'))
}

/** List the files of one directory, treating absence as an empty directory. */
async function listFiles(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile())
      .map(entry => join(directory, entry.name))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw error
  }
}

/**
 * Mount one real peer-session composition over a temp home.
 * @param options - peer config, model script, and an optional existing home.
 * @returns the mounted harness; the caller owns its disposal.
 */
export async function mountPeerHarness(options: PeerHarnessOptions = {}): Promise<PeerHarness> {
  const tree = await mkdtemp(join(tmpdir(), 'peer-sessions-'))
  const home = options.home ?? join(tree, 'home')
  const workdir = join(tree, 'repo')
  await mkdir(workdir, { recursive: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(tree, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([...(options.script ?? textScript(64))])
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.sessionProjections.register(titleProjectionDefinition)
  await ctx.plugin(PeerService, options.peer ?? {})

  const createHandle = async (id: string, agentOptions: PeerAgentOptions = {}): Promise<AgentHandle> => {
    const cwd = agentOptions.cwd === null ? undefined : agentOptions.cwd ?? workdir
    const meta: PeerMeta = {
      ...cwd === undefined ? {} : { cwd },
      ...agentOptions.meta,
    }
    return await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId(id),
      meta,
      agentOptions: agentOptions.agentOptions ?? { provider: 'mock', model: 'mock' },
      ...agentOptions.seed === undefined ? {} : { seed: agentOptions.seed },
      ...agentOptions.inheritedEventCount === undefined
        ? {}
        : { inheritedEventCount: agentOptions.inheritedEventCount },
    })
  }

  return {
    ctx,
    home,
    workdir,
    adapter,
    createHandle,
    create: async (id, agentOptions) => (await createHandle(id, agentOptions)).agent,
    makeDirectory: async (name) => {
      const directory = join(tree, name)
      await mkdir(directory, { recursive: true })
      return directory
    },
    plantMail: async (targetId, filename, content) => {
      const shard = mailShardDirectory(home, targetId)
      await mkdir(shard, { recursive: true, mode: 0o700 })
      const path = join(shard, filename)
      await writeFile(path, content, { mode: 0o600 })
      return path
    },
    mailFiles: async targetId => await listFiles(mailShardDirectory(home, targetId)),
    watchFiles: async targetId => await listFiles(watchShardDirectory(home, targetId)),
    events: agent => agent.session.snapshotEvents(),
    userMessages: agent => agent.session.snapshotEvents()
      .filter((event): event is Extract<SessionEvent, { type: 'user/message' }> => event.type === 'user/message')
      .map(event => event.data),
    pending: (agent) => {
      const state = ctx.sessionProjections.stateOf(agent.session, 'inbox')
      return state === undefined ? [] : [...state['next-turn'], ...state['next-step']]
    },
    dispose: async () => {
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(tree, { recursive: true, force: true })
    },
  }
}

/** Read every presence row file name and body this home holds. */
export async function readPresenceRows(home: string): Promise<readonly { readonly name: string; readonly body: unknown }[]> {
  const directory = presenceDirectory(home)
  const names = await listFiles(directory)
  const rows: { name: string; body: unknown }[] = []
  for (const path of names) {
    const raw = await readFile(path, 'utf8')
    const body: unknown = JSON.parse(raw)
    rows.push({ name: path.slice(directory.length + 1), body })
  }
  return rows
}
