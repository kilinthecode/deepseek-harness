import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

/**
 * The launcher owns Node's module compile cache: one cache directory under the
 * resolved Harness home, never inside the installed package, and never when the
 * invocation or the deployment environment opted out.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshSourceBin = 'apps/cli/src/bin.ts'
const LAUNCH_TIMEOUT_MS = 60_000

interface CacheRun {
  code: number
  stderr: string
  /** Whether the launcher created `<home>/cache/node-compile-cache`. */
  enabled: boolean
}

/**
 * Spawn the source launcher against a private Harness home, with the ambient
 * compile-cache choice removed so only `env` can supply one.
 */
async function launchWithHome(args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<CacheRun> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-compile-cache-'))
  const childEnv = Object.fromEntries(
    Object.entries({ ...process.env, DSH_HOME: home })
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  delete childEnv.NODE_COMPILE_CACHE
  delete childEnv.NODE_DISABLE_COMPILE_CACHE
  Object.assign(childEnv, env)
  try {
    const result = await execa(process.execPath, ['--import', 'tsx/esm', dshSourceBin, ...args], {
      cwd: repoRoot,
      input: '',
      timeout: LAUNCH_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      reject: false,
      env: childEnv,
      extendEnv: false,
    })
    if (result.timedOut) {
      throw new Error(`dsh source launch did not exit within ${LAUNCH_TIMEOUT_MS / 1_000}s. stderr:\n${result.stderr}`)
    }
    return {
      code: result.exitCode ?? -1,
      stderr: result.stderr,
      enabled: existsSync(join(home, 'cache', 'node-compile-cache')),
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe('launcher Node compile cache', () => {
  it('caches under the resolved Harness home on an ordinary launch', async () => {
    const run = await launchWithHome([])
    expect(run.stderr).toContain('--profile <name> is required')
    expect(run.enabled).toBe(true)
  }, LAUNCH_TIMEOUT_MS * 2)

  it.each([[['--version']], [['--help']], [['--patch', './overlay.yml', '-h']]])('never enables the cache for %j', async (args) => {
    const run = await launchWithHome(args)
    expect(run.code).toBe(0)
    expect(run.enabled).toBe(false)
  }, LAUNCH_TIMEOUT_MS * 2)

  it('leaves an explicit NODE_COMPILE_CACHE to Node', async () => {
    const explicit = mkdtempSync(join(tmpdir(), 'dsh-explicit-compile-cache-'))
    try {
      const run = await launchWithHome([], { NODE_COMPILE_CACHE: explicit })
      expect(run.enabled).toBe(false)
    } finally {
      rmSync(explicit, { recursive: true, force: true })
    }
  }, LAUNCH_TIMEOUT_MS * 2)

  it('leaves NODE_DISABLE_COMPILE_CACHE to Node', async () => {
    const run = await launchWithHome([], { NODE_DISABLE_COMPILE_CACHE: '1' })
    expect(run.enabled).toBe(false)
  }, LAUNCH_TIMEOUT_MS * 2)
})
