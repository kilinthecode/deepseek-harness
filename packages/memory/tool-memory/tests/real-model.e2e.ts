import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'
import { ask, catalogEvents, cleanupRoots, freshRoot, mountStore, waitForIdle } from './helpers.ts'

/**
 * Key-gated smoke: a REAL model drives the REAL memory tools over a real
 * store, then a second harness over the same storage root, with none of the
 * first session's transcript, receives the catalog before its first request
 * and answers from memory. Every assertion reads the world (session log,
 * record file), never the model's prose alone.
 */

const PERSONA = 'You are a coding assistant. Keep replies terse. Before answering any question about the user\'s '
  + 'preferences, call memory_recall first and answer from what it returns.'
const MODEL = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const NAME = 'prefers-pnpm'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await cleanupRoots()
})

async function harness(root: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: PERSONA } })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepSeek)
  await mountStore(ctx, root, { maxRecords: 200 })
  await ctx.plugin(ToolMemory, { injectMaxBytes: 4096, maxRecallResults: 8 })
  return ctx
}

function toolCalls(log: readonly SessionEvent[], name: string): { arguments: string }[] {
  return log.flatMap(event => (event.type === 'tool/call' && event.data.name === name ? [event.data] : []))
}

function finalText(log: readonly SessionEvent[]): string {
  const message = log.findLast(event => event.type === 'assistant/message')
  if (message?.type !== 'assistant/message') return ''
  return message.data.message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('durable memory with a real model', () => {
  it('writes a memory in one session and recalls it in a fresh session over the same store', async () => {
    const root = await freshRoot()

    const first = await harness(root)
    const writer = await first.agentLoop.create(SessionId('memory-e2e-write'), MODEL)
    ask(writer, `Remember for future sessions that I prefer pnpm over npm for installs. Save it now with memory_write as a global memory named ${NAME}, then reply DONE.`)
    await waitForIdle(first, writer)

    const written = writer.session.snapshotEvents()
    const writes = toolCalls(written, 'memory_write')
    expect(writes.length).toBeGreaterThan(0)
    expect(JSON.parse(writes[0]!.arguments)).toMatchObject({ name: NAME, scope: 'global' })
    // The world: one record file with the stored fields, independent of the reply.
    const document = JSON.parse(await readFile(join(root, 'memory', 'global', `${NAME}.json`), 'utf8')) as {
      version: number
      record: { name: string; scope: string; content: string; createdAt: string; updatedAt: string }
    }
    expect(document.version).toBe(1)
    expect(document.record).toMatchObject({ name: NAME, scope: 'global' })
    expect(document.record.content).toMatch(/pnpm/i)
    // Rewriting the same name is a legitimate model choice, so the timestamps
    // are ordered rather than equal.
    expect(Date.parse(document.record.createdAt)).toBeLessThanOrEqual(Date.parse(document.record.updatedAt))
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const second = await harness(root)
    const reader = await second.agentLoop.create(SessionId('memory-e2e-recall'), MODEL)
    ask(reader, 'Which package manager do I prefer for installs? Check your saved memories before answering, then answer in one line.')
    await waitForIdle(second, reader)

    const read = reader.session.snapshotEvents()
    const catalogs = catalogEvents(read)
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]!.index).toBeLessThan(read.findIndex(event => event.type === 'assistant/message'))
    expect(catalogs[0]!.text).toContain(`${NAME} —`)
    // The body was read through memory_recall and the answer carries it.
    expect(toolCalls(read, 'memory_recall').length).toBeGreaterThan(0)
    const result = read.find(event => event.type === 'tool/result')
    expect(JSON.stringify(result?.data.message.content)).toMatch(/pnpm/i)
    expect(finalText(read)).toMatch(/pnpm/i)
  }, 180_000)
})
