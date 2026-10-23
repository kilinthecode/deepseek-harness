/** Shared fixtures: temporary git repositories, a real service composition, and a fake parent Agent. */

import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
 * @param objectFormat - `sha256` for a SHA-256 repository, whose commit ids have 64 digits; default SHA-1.
 * @returns the repository's absolute directory.
 */
export async function initFixtureRepo(prefix: string, objectFormat: 'sha1' | 'sha256' = 'sha1'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  git(dir, 'init', '-q', '-b', 'main', `--object-format=${objectFormat}`)
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
 * What a sandboxed child can do to the directory it writes: replace the worktree's `.git` entry with a repository of
 * its own whose configuration runs a command. Any git process that trusts the entry executes the command.
 * @param worktreePath - the linked worktree directory.
 * @param marker - a file the command creates, which a test checks to see whether the command ran.
 */
export async function replaceGitEntryWithFsmonitorRepo(worktreePath: string, marker: string): Promise<void> {
  await rm(join(worktreePath, '.git'), { recursive: true, force: true })
  git(worktreePath, 'init', '-q')
  git(worktreePath, 'config', 'core.fsmonitor', `touch ${marker}; echo`)
}

/**
 * Plant hook scripts a child could write inside its worktree; each creates `<marker>-<hook name>` when it runs.
 * @param hooksDir - the directory a relative `core.hooksPath` names, inside the worktree.
 * @param names - the hooks to plant.
 * @param marker - the marker file name prefix.
 */
export async function plantHooks(hooksDir: string, names: readonly string[], marker: string): Promise<void> {
  await mkdir(hooksDir, { recursive: true })
  for (const name of names) {
    const path = join(hooksDir, name)
    await writeFile(path, `#!/bin/sh\ntouch "${marker}-${name}"\n`)
    await chmod(path, 0o755)
  }
}

/**
 * Add one submodule at `sub` to a fixture repository, from a throwaway local source repository, and commit it. The
 * submodule is left checked out at the source's newer commit — which is what the gitlink records — so a test can move
 * either side of that pair apart. A real `git submodule add` is used, not `git add` of a plain nested repository,
 * because `git status` and `git diff` only report a submodule that is active, which the URL in the repository's config
 * decides; the local-path clone it performs needs `protocol.file.allow=always`, like any other local transport.
 * @param dir - the fixture repository, which must already have a commit for the gitlink to be committed into.
 * @param prefix - `mkdtemp` prefix of the throwaway source repository.
 * @returns the submodule's working directory and the source repository's two commits, older first.
 */
export async function addFixtureSubmodule(dir: string, prefix: string): Promise<{ subdir: string; older: string; newer: string }> {
  const from = await initFixtureRepo(prefix)
  git(from, 'commit', '--allow-empty', '-q', '-m', 'one')
  const older = git(from, 'rev-parse', 'HEAD').trim()
  git(from, 'commit', '--allow-empty', '-q', '-m', 'two')
  const newer = git(from, 'rev-parse', 'HEAD').trim()
  git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', from, 'sub')
  const subdir = join(dir, 'sub')
  // The clone has no commit identity of its own, and it is where these tests make further commits.
  git(subdir, 'config', 'user.name', 'Worktree Test')
  git(subdir, 'config', 'user.email', 'worktree-test@example.com')
  git(subdir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'submodule.sub.url', from)
  git(dir, 'commit', '-q', '-m', 'add the submodule')
  await removeFixture(from)
  return { subdir, older, newer }
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
  requireDistinctReviewer: false,
  testCommand: [],
  checkTimeoutMs: 60_000,
  reviewDiffMaxBytes: 1024,
  removeOnMerge: true,
} satisfies Omit<Config, 'root'>

/**
 * The complete `Config` `setup` mounts the service with: the test defaults with `config` laid over them.
 * @param config - `root` plus any `Config` overrides.
 * @returns the full configuration, for tests that call an internal operation directly with their own git runner.
 */
export function resolveTestConfig(config: TestConfig): Config {
  return { ...DEFAULT_TEST_CONFIG, ...config }
}

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
  await ctx.plugin(SubagentWorktrees, resolveTestConfig(config))
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
