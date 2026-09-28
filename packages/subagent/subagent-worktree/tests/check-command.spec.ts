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

describe('runCheckCommand', () => {
  it('reports exit code 0 and combined stdout on success', async () => {
    const sp = await subprocess()
    const result = await runCheckCommand(sp, [process.execPath, '-e', 'console.log("ok")'], process.cwd(), signal)
    expect(result.exitCode).toBe(0)
    expect(result.combinedOutput).toContain('ok')
  })

  it('reports a nonzero exit code and concatenates stdout then stderr', async () => {
    const sp = await subprocess()
    const script = 'process.stdout.write("out-first"); process.stderr.write("err-second"); process.exit(3)'
    const result = await runCheckCommand(sp, [process.execPath, '-e', script], process.cwd(), signal)
    expect(result.exitCode).toBe(3)
    expect(result.combinedOutput).toBe('out-firsterr-second')
  })
})
