/** The runner glue: the launcher-exit fail-loud check, the post-settlement service guard, and non-Error failure reporting. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, Config } from '../src/index.ts'
import { internals } from '../src/runner-internals.ts'
import { bench } from './harness.ts'

describe('agents-runner glue', () => {
  it('fails loud without the launcher-provided exit request', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, new Config({ verb: 'discard', id: 'wt-1', json: false })) })
      .toThrow('agents-runner: the launcher must provide ctx.appExit before the tree mounts')
  })

  it('abandons a run when a required service is missing once the loader settles', async () => {
    const ctx = new Context()
    let exited = false
    internals.stdout = { write: () => true }
    internals.stderr = { write: () => true }
    ctx.provide('appExit', () => { exited = true })
    // agentDefaultModel is deliberately left unmounted: the composition can be
    // disposed between loader settlement and this check running.
    ctx.provide('agents', {} as never)
    ctx.provide('sessions', {} as never)
    ctx.provide('subagents', {} as never)
    ctx.provide('subagentWorktrees', {} as never)
    apply(ctx, new Config({ verb: 'discard', id: 'wt-1', json: false }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(exited).toBe(false)
    await ctx.fiber.dispose()
  })

  it('stringifies a non-Error failure thrown by an injected service', async () => {
    const test = await bench({
      worktrees: {
        discard: () => { throw 'boom' },
      },
    })
    const result = await test.run({ verb: 'discard', id: 'wt-aaaaaaaa', json: true })
    expect(result.code).toBe(1)
    expect(result.err).toBe('dsh: boom\n')
    expect(JSON.parse(result.out.trim())).toEqual({ type: 'error', message: 'boom' })
    await test.ctx.fiber.dispose()
  })
})
