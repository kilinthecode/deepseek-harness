/** Source and published Portal entry, including supervised terminal conversations. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const repo = fileURLToPath(new URL('../../../../../../', import.meta.url))
const patch = fileURLToPath(new URL('./fixtures/portal.patch.yml', import.meta.url))
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function world(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'portal-cli-'))
  roots.push(root)
  return { root, home: join(root, '.dsh') }
}

async function run(signal: AbortSignal, root: string, home: string, args: string[], input = '') {
  const launch = resolveExampleLaunch({
    srcBin: join(repo, 'apps/cli/src/bin.ts'),
    tsconfigPath: join(repo, 'tsconfig.json'), sourceImport: 'tsx/esm',
    configArgs: ['portal', '--patch', patch, ...args],
    env: { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
  })
  const result = await execa(launch.command, launch.args, {
    cwd: root, env: launch.env, input, reject: false, timeout: 120_000, cancelSignal: signal,
  })
  expect(result.timedOut).toBe(false)
  expect(result.isCanceled).toBe(false)
  expect(result.signal).toBeUndefined()
  return result
}

it('lists routes and models without creating a Session', async ({ signal }) => {
  const { root, home } = await world()
  const result = await run(signal, root, home, ['models', '--provider', 'portal-test', '--json'])
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stderr).toBe('')
  const sessions = (await readdir(home)).includes('sessions') ? await readdir(join(home, 'sessions')) : []
  expect(sessions).toEqual([])
  expect(JSON.parse(result.stdout)).toEqual({ providers: [{
    id: 'portal-test', name: 'portal-test', models: [
      { provider: 'portal-test', id: 'first', name: 'first' },
      { provider: 'portal-test', id: 'second', name: 'second' },
    ],
  }] })
})

it('runs a selected model, reports its Session, and resumes it in a later process', async ({ signal }) => {
  const { root, home } = await world()
  const first = await run(signal, root, home, ['--provider', 'portal-test', '--model', 'second', '--reasoning-effort', 'off', '--json', 'hello'])
  expect(first.exitCode, first.stderr).toBe(0)
  const events = first.stdout.split('\n').map(line => JSON.parse(line) as { type: string; id?: string; text?: string; sessionId?: string })
  expect(events.at(-1)).toMatchObject({ type: 'final', text: 'PORTAL_OK portal-test/second off turn=1' })
  const opening = events.find(event => event.type === 'session')
  const id = opening?.sessionId ?? opening?.id
  expect(id).toBeTypeOf('string')
  const resumed = await run(signal, root, home, ['--session-id', id!, '--model', 'second', 'continue'])
  expect(resumed.exitCode, resumed.stderr).toBe(0)
  expect(resumed.stdout).toContain('PORTAL_OK portal-test/second default turn=2')
})

it('keeps a terminal conversation open across model selection and two tasks', async ({ signal }) => {
  const { root, home } = await world()
  const result = await run(signal, root, home, ['--interactive'], '/models portal-test\n/model portal-test second\n/reasoning off\nhello\ncontinue\n/session\n/exit\n')
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stdout).toContain('PORTAL')
  expect(result.stdout).toContain('Model: portal-test/first')
  expect(result.stdout).toContain('PORTAL_OK portal-test/second off turn=1')
  expect(result.stdout).toContain('PORTAL_OK portal-test/second off turn=2')
  const ids = [...result.stdout.matchAll(/Session: (session-[^\s]+)/g)].map(match => match[1])
  expect(ids).toHaveLength(2)
  expect(ids[0]).toBe(ids[1])
  expect(result.stdout).toContain('Tokens: 10 in / 5 out')
})

it('starts fresh conversations and resumes a stored conversation through terminal controls', async ({ signal }) => {
  const { root, home } = await world()
  const first = await run(signal, root, home, ['--json', 'hello'])
  expect(first.exitCode, first.stderr).toBe(0)
  const opening = first.stdout.split('\n').map(line => JSON.parse(line) as { type: string; sessionId?: string })
    .find(event => event.type === 'session')
  expect(opening?.sessionId).toBeTypeOf('string')
  const result = await run(signal, root, home, ['--interactive'], [
    '/help', 'hello', '/status', '/new', '/models portal-test', '/model 2', '/reasoning off', 'hello',
    `/resume ${opening!.sessionId!}`, 'continue', '/status', '/clear', '/exit', '',
  ].join('\n'))
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toContain('/resume <id>')
  expect(result.stdout).toContain('New conversation ready')
  expect(result.stdout).toContain('PORTAL_OK portal-test/first default turn=1')
  expect(result.stdout).toContain('PORTAL_OK portal-test/second off turn=1')
  expect(result.stdout).toContain('PORTAL_OK portal-test/second off turn=2')
  expect(result.stdout).toContain('Turns: 2')
  const ids = [...result.stdout.matchAll(/Session: (session-[^\s]+)/g)].map(match => match[1])
  expect(new Set(ids).size).toBe(3)
  expect(ids).toContain(opening!.sessionId)
  expect(result.stdout).not.toContain('\u001b')
})

it('takes piped input and reports unavailable routes as a failed task', async ({ signal }) => {
  const { root, home } = await world()
  expect((await run(signal, root, home, [], 'hello from stdin')).stdout).toContain('PORTAL_OK')
  const result = await run(signal, root, home, ['--provider', 'unconfigured', '--model', 'missing', '--json', 'hello'])
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('unconfigured')
})

it('reads Desktop model defaults without changing the Desktop patch', async ({ signal }) => {
  const { root, home } = await world()
  const dir = join(home, 'profiles', 'desktop')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
  const config = '- id: agent-default-model\n  config: {provider: portal-test, model: second}\n'
  await writeFile(join(dir, 'cordis.patch.yml'), config)
  // The explicit scenario overlay supplies a mock adapter but does not override the borrowed default.
  const overlay = join(root, 'adapter.patch.yml')
  await writeFile(overlay, (await readFile(patch, 'utf8')).replace(/- id: agent-default-model\n  config:.*\n/, '').replace("'./portal-llm.mjs'", JSON.stringify(fileURLToPath(new URL('./fixtures/portal-llm.mjs', import.meta.url)))))
  const launch = resolveExampleLaunch({
    srcBin: join(repo, 'apps/cli/src/bin.ts'), tsconfigPath: join(repo, 'tsconfig.json'), sourceImport: 'tsx/esm',
    configArgs: ['portal', '--models-from', 'desktop', '--patch', overlay, 'hello'],
    env: { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
  })
  const result = await execa(launch.command, launch.args, { cwd: root, env: launch.env, input: '', reject: false, timeout: 120_000, cancelSignal: signal })
  expect(result.timedOut).toBe(false)
  expect(result.isCanceled).toBe(false)
  expect(result.signal).toBeUndefined()
  expect(result.exitCode, result.stderr).toBe(0)
  expect(result.stdout).toContain('PORTAL_OK portal-test/second')
  expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(config)
  expect(await readdir(join(home, 'sessions'))).toHaveLength(1)
})
