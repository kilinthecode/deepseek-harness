// Shared mounting for memory-review suites: a real storage stack, the memory
// tools, the in-process fork provider, and the real agent loop. Only the model
// is scripted.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, type GenerateOptions, type LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import MemoryStore from '@deepseek-ai/dsh-memory'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as MemoryReview from '../src/index.ts'
import { REVIEW_LABEL, REVIEW_PROMPT } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

/**
 * Own `ctx` for {@link cleanup} so a thrown test still disposes it.
 * @param ctx - context created outside {@link harness}.
 */
export function track(ctx: Context): void {
  contexts.push(ctx)
}

/**
 * Create a scenario-local storage root; {@link cleanupRoots} removes it.
 * @returns the absolute root.
 */
export async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-review-'))
  roots.push(root)
  return root
}

/** Remove every root created by {@link freshRoot} and dispose mounted contexts. */
export async function cleanup(): Promise<void> {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
}

/**
 * Mount the storage hub, the json backend, the domain form, and the memory store.
 * @param ctx - context that owns the mounted services.
 * @param root - json backend root.
 */
export async function mountStore(ctx: Context, root: string): Promise<void> {
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryStore, { maxRecords: 20, maxRecordBytes: 4096 })
}

/**
 * Create `<root>/<name>/.git` plus a nested working directory inside it.
 * @param root - parent directory.
 * @param name - project directory name.
 * @returns the project root and a working directory below it.
 */
export async function project(root: string, name: string): Promise<{ root: string; cwd: string }> {
  const projectRoot = join(root, name)
  await mkdir(join(projectRoot, '.git'), { recursive: true })
  const cwd = join(projectRoot, 'src')
  await mkdir(cwd, { recursive: true })
  return { root: projectRoot, cwd }
}

/**
 * Resolve once the agent reports `idle` on `agent/status`.
 * @param ctx - context the agent loop runs in.
 * @param agent - agent to wait for.
 */
export function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  if (agent.status === 'idle') return Promise.resolve()
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/**
 * Queue one human turn.
 * @param agent - agent that receives the follow-up.
 * @param text - user message text.
 */
export function ask(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/**
 * Text of the last user-role message in a model request.
 * @param options - request recorded by the mock adapter.
 * @returns concatenated text blocks, or `''` when none exist.
 */
export function lastUserText(options: GenerateOptions): string {
  for (let index = options.messages.length - 1; index >= 0; index -= 1) {
    const message = options.messages[index]
    if (message === undefined || message.role !== 'user') continue
    return message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
  }
  return ''
}

/**
 * Whether any user-role message in a request carries the exact
 * {@link REVIEW_PROMPT} text. Every in-process child also carries a
 * dynamically rendered `runtime-context` user message after its newest
 * turn (the universal delegated-subagent scope notice from
 * `applyChildComposition`), so the review prompt is not reliably the last
 * user message once that notice is appended.
 * @param options - request recorded by the mock adapter.
 * @returns true when a user message's text content equals {@link REVIEW_PROMPT}.
 */
export function includesReviewPrompt(options: GenerateOptions): boolean {
  return options.messages.some(message => message.role === 'user'
    && message.content.some(block => block.type === 'text' && block.text === REVIEW_PROMPT))
}

/**
 * Scripted mock that answers parent turns with `ok` and review-child turns
 * from `childTurns`, switching when a user message carries {@link REVIEW_PROMPT}.
 * @param childTurns - model streams for successive child requests.
 * @returns a mock adapter with enough repeating entries for a long parent.
 */
export function reviewAdapter(childTurns: StreamChunk[][]): MockAdapter {
  const remaining = new Map<string, StreamChunk[][]>()
  const entry = (options: GenerateOptions): StreamChunk[] => {
    const id = String(options.sessionId ?? 'unknown')
    if (includesReviewPrompt(options) && !remaining.has(id)) {
      remaining.set(id, [...childTurns])
    }
    const queue = remaining.get(id)
    if (queue !== undefined) {
      const next = queue.shift()
      if (next === undefined) throw new Error('MockAdapter: child script exhausted')
      return next
    }
    return textResponse('ok')
  }
  return new MockAdapter(Array.from({ length: 64 }, () => entry))
}

/**
 * Parent-log catalog rows this plugin started.
 * @param log - session events in order.
 * @returns matching `subagent/catalog` events.
 */
export function reviewCatalog(log: readonly SessionEvent[]): SessionEvent[] {
  return log.filter(event => event.type === 'subagent/catalog' && event.data.label === REVIEW_LABEL)
}

/**
 * Wait until this plugin starts a review child of `parent` and that child is idle.
 * Subscribe before the triggering parent turn; the start is fire-and-forget.
 * @param ctx - context the agents live in.
 * @param parent - parent whose idle starts the review.
 * @returns the idle review child.
 */
export function waitForReviewChild(ctx: Context, parent: Agent): Promise<Agent> {
  return new Promise((resolve, reject) => {
    const dispose = ctx.on('subagent/start', (info) => {
      if (info.provider !== 'fork') return
      const child = ctx.agents.get(info.id)
      if (child === undefined || child.session.header.parentSession !== parent.session.id) return
      const labeled = reviewCatalog(parent.session.snapshotEvents())
        .some(event => event.type === 'subagent/catalog' && event.data.childId === info.id)
      if (!labeled) return
      dispose()
      void child.whenIdle().then(() => { resolve(child) }, reject)
    })
  })
}

/**
 * Mount the real loop, store, memory tools, fork provider, and memory-review.
 * @param adapter - scripted model; a plain `MockAdapter` or any other `LlmAdapter`
 * (e.g. one that routes per session id for a scenario with several concurrently live agents).
 * @param config - review configuration.
 * @param root - json storage root.
 * @returns the booted context and the memory-review fiber.
 */
export async function harness(
  adapter: LlmAdapter,
  config: Config,
  root: string,
): Promise<{ ctx: Context; reviewFiber: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountStore(ctx, root)
  await ctx.plugin(ToolMemory, { injectMaxBytes: 2048, maxRecallResults: 4 })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Fork, { providerName: 'fork' })
  const reviewFiber = await ctx.plugin(MemoryReview, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, reviewFiber }
}

/**
 * Create a parent agent on the mock route.
 * @param ctx - booted harness context.
 * @param id - session id.
 * @param cwd - optional working directory.
 * @returns the published parent.
 */
export async function createParent(ctx: Context, id: string, cwd?: string): Promise<Agent> {
  return ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' }, cwd === undefined ? {} : { cwd })
}
