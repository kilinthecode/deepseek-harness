import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { fsHarness, waitForIdle } from './harness.ts'

/** Key-gated smoke for a real model driving the local read/write/edit tools. */

let ctx: Context | undefined
let workdir: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

const SYSTEM = 'You are a coding assistant. Use the write tool to create files, the read tool to inspect '
  + 'them, and the edit tool for literal replacements. Read a file before editing it. Keep replies terse.'

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('fs tools with-key smoke', () => {
  it('continues beyond the default read window to find and save a late-file token', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-fs-window-e2e-'))
    const source = Array.from({ length: 24 }, (_, index) => index === 20 ? 'final token: amber-seven' : `record ${index + 1}`).join('\n')
    await writeFile(join(workdir, 'records.txt'), source)
    ctx = await fsHarness(workdir, SYSTEM, { readDefaultLimit: 4, readLimit: 12 })
    const agent = await ctx.agentLoop.create(SessionId('fs-window-e2e'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'First use read on records.txt without offset or limit. Then continue reading '
        + 'with offset and limit as needed to find its final token. Create answer.txt containing only that token. '
        + 'Do not change records.txt. Keep the reply terse.' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, agent)

    expect((await readFile(join(workdir, 'answer.txt'), 'utf8')).trim()).toBe('amber-seven')
    expect(await readFile(join(workdir, 'records.txt'), 'utf8')).toBe(source)
    const events = agent.session.snapshotEvents()
    const reads = events.filter(event => event.type === 'tool/call').filter(event => event.data.name === 'read')
    expect(reads[0]).toBeDefined()
    expect(JSON.parse(reads[0]?.data.arguments ?? 'null')).toEqual({ file_path: 'records.txt' })
    expect(reads.length).toBeGreaterThan(1)
    const firstRead = events.filter(event => event.type === 'tool/result').find(event => event.data.message.toolCallId === reads[0]?.data.callId)
    expect(firstRead?.data.meta).toMatchObject({ offset: 1, totalLines: 24, lines: [
      { number: 1, text: 'record 1' }, { number: 2, text: 'record 2' },
      { number: 3, text: 'record 3' }, { number: 4, text: 'record 4' },
    ] })
  }, 180_000)

  it('creates, reads, then edits a file — verified on disk', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-fs-e2e-'))
    ctx = await fsHarness(workdir, SYSTEM)
    // agentLoop.create prepares a session with no cwd, so the provider default
    // (config.cwd = workdir) is the workspace.
    const agent = await ctx.agentLoop.create(SessionId('fs-e2e'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text:
      'Create a file named note.txt containing exactly the line: status: draft. '
      + 'Then read it back, then edit it to replace the literal word draft with final. '
      + 'Tell me when done.' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // Assert the filesystem effect independently of the model response.
    const content = await readFile(join(workdir, 'note.txt'), 'utf8')
    expect(content).toContain('status: final')
    expect(content).not.toContain('draft')

    // The log records real read/write/edit tool calls (not bash).
    const calls = agent.session.snapshotEvents().filter(e => e.type === 'tool/call').map(e => e.data.name)
    expect(calls).toContain('write')
    expect(calls).toContain('read')
    expect(calls).toContain('edit')
  }, 180_000)

  it('resolves a relative path against the per-session cwd (factory meta.cwd)', async () => {
    // config.cwd is the harness workdir, but the agent's SESSION cwd is a
    // different dir; the write must land in the SESSION dir, proving the tool
    // passes the per-session cwd (not the backend default).
    const configDir = await mkdtemp(join(tmpdir(), 'dsh-fs-e2e-cfg-'))
    workdir = configDir
    const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-fs-e2e-session-'))
    try {
      ctx = await fsHarness(configDir, SYSTEM)
      const handle = await ctx.agents.create({
        sessionId: SessionId(`fs-e2e-cwd-${Date.now()}`),
        meta: { cwd: sessionDir },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      })
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text:
        'Use the write tool to create a file named where.txt containing exactly the line: here. Tell me when done.' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, handle.agent)

      // The file is in the SESSION dir, not the config dir.
      expect(await readFile(join(sessionDir, 'where.txt'), 'utf8')).toContain('here')
      await expect(readFile(join(configDir, 'where.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(sessionDir, { recursive: true, force: true })
    }
  }, 180_000)
})
