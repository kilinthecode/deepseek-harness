/** Shared fixtures: temporary git repositories, a real service composition, and a fake parent Agent. */

import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SubagentWorktrees from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { CreateWorktreeRequest, ProvisionedWorktree, WorktreeOwner } from '../src/types.ts'

/** Run git synchronously inside a fixture repository. Never used by the code under test — fixture setup only. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Create a temporary git repository with a local commit identity and no GPG
 * signing, so an automated `git commit` never blocks on host or global config.
 * @param prefix - `mkdtemp` prefix.
 * @returns the repository's absolute directory.
 */
export async function initFixtureRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Worktree Test')
  git(dir, 'config', 'user.email', 'worktree-test@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

/** Remove a fixture directory tree; safe to call on an already-removed path. */
export function removeFixture(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true })
}

/**
 * Build a minimal parent Agent: exactly the three members `parentAgentOptionsForDelegation`
 * and the reviewer's `parent` field read (`id`, `options`, `session`). `Agent` is an interface
 * merged from many packages, so a literal of only these members needs one assertion.
 */
export function fakeAgent(id: string, options: AgentOptions = {}): Agent {
  const sessionId = SessionId(id)
  return { id: sessionId, options, session: Session.create(sessionId) } as Agent
}

/** Default worker route used by {@link createWorktree} when a test does not care about its exact value. */
export const DEFAULT_WORKER_ROUTE = { provider: 'worker-provider', model: 'worker-model' }

/** Config fields every test must supply explicitly (no service-level defaults are assumed by the fixtures). */
export type TestConfig = Partial<Config> & { root: string }

const DEFAULT_TEST_CONFIG = {
  branchPrefix: 'dsh/worktree/',
  maxWorktrees: 16,
  requireDistinctReviewer: true,
  testCommand: [],
  checkTimeoutMs: 60_000,
  reviewDiffMaxBytes: 1024,
  removeOnMerge: true,
} satisfies Omit<Config, 'root'>

/**
 * Mount the real subprocess, subagent, and worktree services in a fresh context.
 * @param config - `root` (always required — an isolated tmp directory) plus any `Config` overrides.
 * @returns the composed context and its disposer.
 */
export async function setup(config: TestConfig): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentWorktrees, { ...DEFAULT_TEST_CONFIG, ...config })
  return { ctx, dispose: () => ctx.fiber.dispose() }
}

/**
 * Create one worktree through the real service, defaulting `workerRoute` and
 * `signal` for call sites that do not care about their exact values.
 * @param ctx - a context with `subagentWorktrees` mounted.
 * @param owner - authority recorded on the worktree.
 * @param baseDir - the base checkout directory.
 * @param label - short display label; also used as the task text.
 * @param overrides - any `CreateWorktreeRequest` fields to override.
 * @returns the provisioned worktree.
 */
export function createWorktree(
  ctx: Context,
  owner: WorktreeOwner,
  baseDir: string,
  label: string,
  overrides: Partial<CreateWorktreeRequest> = {},
): Promise<ProvisionedWorktree> {
  return ctx.subagentWorktrees.create({
    owner, baseDir, label, task: label, workerRoute: DEFAULT_WORKER_ROUTE, signal: new AbortController().signal, ...overrides,
  })
}
