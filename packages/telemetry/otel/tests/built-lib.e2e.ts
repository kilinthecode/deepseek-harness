/** Plain-Node publication smoke for the lazily loaded OTel service. */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const entry = new URL('../lib/index.js', import.meta.url)
const packageDir = fileURLToPath(new URL('..', import.meta.url))

describe.skipIf(process.env.DSH_EXAMPLE_MODE !== 'lib' && !existsSync(entry))('built OTel entry', () => {
  it('loads the published entry and keeps closed channels from importing the SDK', async ({ signal }) => {
    const script = `
      import { registerHooks } from 'node:module'
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.startsWith('@opentelemetry/') || specifier === 'got') throw new Error('closed channel loaded the SDK')
        return next(specifier, context)
      } })
      const { Context } = await import('@deepseek-ai/cordis')
      const { default: OTel } = await import(${JSON.stringify(entry.href)})
      const ctx = new Context()
      await ctx.plugin(OTel)
      const options = {
        scope: { name: 'built-closed-channel' }, exporter: { url: 'http://127.0.0.1:1/v1/logs' },
        resourceAttributes: {}, onFailure: message => { throw new Error(message) },
      }
      const event = ctx.otel.createEventReporter(options)
      const session = ctx.otel.createSessionLogReporter(options)
      await Promise.all([event.shutdown(), session.shutdown()])
      event.emit({ eventName: 'late', body: 'late', timestamp: 1 })
      session.reportSessionLog({ sessionId: 'late', event: { type: 'user/message', seq: 0, time: 1,
        surfaceOp: 'append', data: { content: [] } } })
      await Promise.all([event.shutdown(), session.shutdown()])
      await ctx.fiber.dispose()
      console.log('closed-without-sdk')
    `
    const result = await execa(process.execPath, ['--input-type=module', '-e', script], {
      cwd: packageDir, cancelSignal: signal, reject: false,
    })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toBe('closed-without-sdk')
  })
})
