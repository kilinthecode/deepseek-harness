/** Shipped-profile read windows, program bindings, instruction ordering, and durable presentation. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const binScript = fileURLToPath(new URL('../../../../../../apps/cli/src/bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/token-context.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))

it.each(['native', 'ptc'] as const)('uses smaller read defaults and explicit larger windows through %s in the shipped profile', async (mode) => {
  let persisted: SessionEvent[] = []
  const { stdout } = await runLoaderSmoke({
    label: `token context ${mode}`,
    tempDirPrefix: 'dsh-token-context-',
    binScript, configPath, tsconfigPath, sourceImport: 'tsx/esm',
    binArgs: ['--profile', 'headless', '--patch', configPath, '--patch', './mode.patch.yml', '--json', 'Read the target and save report.txt.'],
    processTimeoutMs: 60_000,
    prepare: async (cwd) => {
      await mkdir(join(cwd, '.git'))
      await writeFile(join(cwd, 'AGENTS.md'), 'Use the read tool for text files. Preserve unrelated files.\n')
      await writeFile(join(cwd, 'large.txt'), Array.from({ length: 12 }, (_, index) => index === 8 ? 'target=SEVENTEEN' : `entry=${index + 1}`).join('\n') + '\n')
      await writeFile(join(cwd, 'mode.patch.yml'), `- id: tools\n  config: {mode: ${mode}}\n`)
    },
    inspect: async (cwd) => {
      expect(await readFile(join(cwd, 'report.txt'), 'utf8')).toBe('2:10:target=SEVENTEEN\n')
      const files = await readdir(join(cwd, '.sessions'), { recursive: true })
      const file = files.find(path => path.endsWith('.jsonl'))
      expect(file).toBeDefined()
      const rows = (await readFile(join(cwd, '.sessions', file!), 'utf8')).trim().split('\n')
      persisted = rows.slice(1).map(row => JSON.parse(row) as SessionEvent)
    },
  })
  expect(stdout).toContain('TOKEN_CONTEXT_COMPLETE')
  const messages = persisted.filter(event => event.type === 'user/message')
  expect(messages[0]?.data.source.kind).toBe('agent-instructions')
  expect(messages[1]?.data.source.kind).toBe('user')
  if (mode === 'native') {
    const readIds = new Set(persisted.filter(event => event.type === 'tool/call').filter(event => event.data.name === 'read').map(event => event.data.callId))
    const reads = persisted.filter(event => event.type === 'tool/result').filter(event => readIds.has(event.data.message.toolCallId))
    expect(reads).toHaveLength(2)
    expect(reads[0]?.data.meta).toMatchObject({ offset: 1, totalLines: 12, lines: [{ number: 1, text: 'entry=1' }, { number: 2, text: 'entry=2' }] })
    expect(reads[1]?.data.meta).toMatchObject({ offset: 3, totalLines: 12 })
  } else {
    const calls = persisted.filter(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'read')
    expect(calls).toHaveLength(2)
  }
}, 75_000)
