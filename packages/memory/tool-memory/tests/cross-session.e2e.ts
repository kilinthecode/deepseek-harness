import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/**
 * The acceptance bar for durable memory, keyless and through the production
 * headless profile: process A writes a memory, process B over the same
 * harness home sees it in the injected catalog before its first request and
 * reads the body back with `memory_recall`.
 */
const binScript = fileURLToPath(new URL('../../../test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/memory.patch.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

let world: string | undefined

afterEach(async () => {
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

async function eventsOf(path: string): Promise<SessionEvent[]> {
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
  return lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
}

function finalOutput(stdout: string): string {
  const result = JSON.parse(stdout.trimEnd().split('\n').at(-1) ?? '') as Record<string, unknown>
  expect(result).toMatchObject({ type: 'result' })
  expect(result['output']).toBeTypeOf('string')
  return result['output'] as string
}

describe('durable memory across two headless processes', () => {
  it('recalls in a fresh process what an earlier process wrote', async () => {
    world = await mkdtemp(join(tmpdir(), 'memory-cross-session-'))
    const cwd = world
    const run = (label: string, task: string) => runLoaderSmoke({
      label,
      cwd,
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, task],
      tsconfigPath: repoTsconfig,
    })

    const first = await run('memory-cross-session-write', 'remember: I use pnpm')
    expect(first.stderr).toBe('')
    expect(finalOutput(first.stdout)).toContain('RESULT: Saved global memory "prefers-pnpm".')
    expect(await readdir(join(cwd, '.dsh', 'storages', 'memory', 'global'))).toEqual(['prefers-pnpm.json'])

    const second = await run('memory-cross-session-recall', 'recall: what do you remember?')
    expect(second.stderr).toBe('')
    expect(finalOutput(second.stdout)).toContain('Always run pnpm, never npm.')

    const logs = await jsonlFiles(join(cwd, '.sessions'))
    expect(logs).toHaveLength(2)
    const sessions = await Promise.all(logs.map(eventsOf))
    const recallSession = sessions.find(events =>
      events.some(event => event.type === 'tool/call' && event.data.name === 'memory_recall'))
    if (recallSession === undefined) throw new Error('no session called memory_recall')
    const catalogIndex = recallSession.findIndex(event =>
      event.type === 'user/message' && event.data.source.kind === 'tool-memory')
    const firstAssistantIndex = recallSession.findIndex(event => event.type === 'assistant/message')
    expect(catalogIndex).toBeGreaterThan(-1)
    expect(catalogIndex).toBeLessThan(firstAssistantIndex)
    expect(JSON.stringify(recallSession[catalogIndex])).toContain('- [user] prefers-pnpm — Uses pnpm, never npm')
    const recallResult = recallSession.find(event => event.type === 'tool/result')
    expect(JSON.stringify(recallResult)).toContain('Always run pnpm, never npm.')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS * 2)
})
