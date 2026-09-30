import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { runCheckCommand } from '../src/check-command.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function subprocess() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  return ctx.subprocess
}

const signal = new AbortController().signal
const GENEROUS_TIMEOUT_MS = 60_000

describe('runCheckCommand', () => {
  it('reports exit code 0 and combined stdout on success', async () => {
    const sp = await subprocess()
    const result = await runCheckCommand(sp, [process.execPath, '-e', 'console.log("ok")'], process.cwd(), signal, GENEROUS_TIMEOUT_MS)
    expect(result.exitCode).toBe(0)
    expect(result.combinedOutput).toContain('ok')
    expect(result.timedOut).toBe(false)
  })

  it('reports a nonzero exit code and concatenates stdout then stderr', async () => {
    const sp = await subprocess()
    const script = 'process.stdout.write("out-first"); process.stderr.write("err-second"); process.exit(3)'
    const result = await runCheckCommand(sp, [process.execPath, '-e', script], process.cwd(), signal, GENEROUS_TIMEOUT_MS)
    expect(result.exitCode).toBe(3)
    expect(result.combinedOutput).toBe('out-firsterr-second')
    expect(result.timedOut).toBe(false)
  })

  it('terminates a command that outlives the deadline and reports it as timed out', async () => {
    const sp = await subprocess()
    const script = 'process.stdout.write("started"); setInterval(() => {}, 1000)'
    const startedAt = Date.now()
    const result = await runCheckCommand(sp, [process.execPath, '-e', script], process.cwd(), signal, 500)
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).not.toBe(0)
    expect(result.combinedOutput).toContain('started')
    expect(Date.now() - startedAt).toBeLessThan(30_000)
  })

  it('does not call a caller-cancelled command timed out', async () => {
    const sp = await subprocess()
    const controller = new AbortController()
    const script = 'process.stdout.write("started"); setInterval(() => {}, 1000)'
    const pending = runCheckCommand(sp, [process.execPath, '-e', script], process.cwd(), controller.signal, GENEROUS_TIMEOUT_MS)
    setTimeout(() => { controller.abort() }, 300)
    const result = await pending
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).not.toBe(0)
  })
})
