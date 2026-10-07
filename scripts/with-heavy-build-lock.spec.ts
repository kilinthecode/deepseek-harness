import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, expect, it } from 'vitest'

const wrapper = join(import.meta.dirname, 'with-heavy-build-lock.mjs')
const roots: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = once(child, 'close')
    child.kill('SIGTERM')
    await closed
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-heavy-'))
  roots.push(root)
  const file = join(root, 'worker.mjs')
  await writeFile(file, 'process.stdout.write(\'started\\n\'); process.stdin.once(\'data\', () => { process.stdout.write(\'finished\\n\'); process.exit(0) });')
  return { root, file, env: { ...process.env, CI: '', DSH_HEAVY_BUILD_LOCK_OWNER: '', DSH_HEAVY_BUILD_LOCK_PATH: join(root, 'lease') } }
}
function launch(args: string[], env: NodeJS.ProcessEnv, raw = true, cwd?: string) {
  const child = spawn(process.execPath, [wrapper, ...(raw ? ['--', process.execPath] : []), ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(child)
  const finished = once(child, 'close')
  const observed: string[] = []
  const pending = new Map<string, () => void>()
  for (const stream of [child.stdout!, child.stderr!]) {
    createInterface({ input: stream }).on('line', (line) => { observed.push(line); pending.get(line)?.() })
  }
  const line = (value: string) => observed.includes(value)
    ? Promise.resolve()
    : new Promise<void>(resolve => pending.set(value, resolve))
  return { child, finished, observed, line }
}
it('serializes separate local commands and releases the lease after child completion', async () => {
  const f = await fixture()
  const a = launch([f.file], f.env)
  await a.line('started')
  const b = launch([f.file], f.env)
  await b.line('Waiting for the other local build or gate to finish.')
  expect(b.observed).not.toContain('started')
  a.child.stdin!.end('release')
  expect((await a.finished)[0]).toBe(0)
  await b.line('started')
  b.child.stdin!.end('release')
  expect((await b.finished)[0]).toBe(0)
})
it('allows nested commands to inherit the owning lease', async () => {
  const f = await fixture()
  const nested = launch(['--input-type=module', '-e', `import { spawnSync } from 'node:child_process'; const r = spawnSync(process.execPath, [${JSON.stringify(wrapper)}, '--', process.execPath, '-e', 'process.stdout.write("nested")'], { stdio: 'inherit' }); process.exit(r.status ?? 1)`], f.env)
  expect((await nested.finished)[0]).toBe(0)
  expect(nested.observed.join('')).toContain('nested')
})
it('propagates failed child status and makes the lease available again', async () => {
  const f = await fixture()
  const a = launch(['-e', 'process.exit(7)'], f.env)
  expect((await a.finished)[0]).toBe(7)
  const b = launch(['-e', 'process.exit(0)'], f.env)
  expect((await b.finished)[0]).toBe(0)
})
it('cancels a waiting command without starting its child', async () => {
  const f = await fixture()
  const a = launch([f.file], f.env)
  await a.line('started')
  const b = launch([f.file], f.env)
  await b.line('Waiting for the other local build or gate to finish.')
  b.child.kill('SIGTERM')
  const result = await b.finished
  // Windows terminates SIGTERM targets without executing their signal handlers.
  if (process.platform !== 'win32') expect(result[0]).toBe(143)
  expect(b.observed).not.toContain('started')
  a.child.stdin!.end('release')
  await a.finished
})
it('uses independent CI allocations without acquiring the local lease', async () => {
  const f = await fixture()
  const a = launch([f.file], f.env)
  await a.line('started')
  const b = launch(['-e', 'process.exit(0)'], { ...f.env, CI: 'true' })
  expect((await b.finished)[0]).toBe(0)
  a.child.stdin!.end('release')
  await a.finished
})
it('rejects relative lease paths before spawning', async () => {
  const f = await fixture()
  const a = launch(['-e', 'process.exit(0)'], { ...f.env, DSH_HEAVY_BUILD_LOCK_PATH: 'relative' })
  expect((await a.finished)[0]).toBe(1)
  expect(a.observed.join('')).toContain('must be absolute')
})


it('wraps every root build and desktop packaging entry', async () => {
  const manifest = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  for (const [name, command] of Object.entries(manifest.scripts)) {
    if (name.startsWith('build') || name.startsWith('package:desktop')) {
      expect(command).toBe(`node scripts/with-heavy-build-lock.mjs heavy:${name}`)
      expect(manifest.scripts[`heavy:${name}`]).toBeTruthy()
    }
  }
})


it.each(['C:\\tools\\pnpm.cmd', process.execPath])('uses the pinned pnpm JavaScript entry regardless of lifecycle launcher %s', async (entry) => {
  const f = await fixture()
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ scripts: { fixture: 'node -e "console.log(12345)"' } }))
  const a = launch(['fixture'], { ...f.env, npm_execpath: entry }, false, f.root)
  expect((await a.finished)[0]).toBe(0)
  expect(a.observed).toContain('12345')
})
