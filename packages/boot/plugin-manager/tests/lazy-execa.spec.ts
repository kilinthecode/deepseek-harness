/** The pnpm process helper is loaded on first use, not with the operations module. */
import { expect, it, vi } from 'vitest'

const loader = vi.hoisted(() => ({ loads: 0 }))
vi.mock('execa', () => {
  loader.loads += 1
  return { execa: async () => ({ exitCode: 0, stdout: 'https://registry.example\n', stderr: '' }) }
})

it('imports execa when an operation first runs and reuses the module', async () => {
  const operations = await import('../src/operations.ts')
  const connection = await import('../src/github-connection.ts')
  // Neither module evaluated the helper at load time.
  expect(loader.loads).toBe(0)
  expect(await operations.viewProfilePackage('/tmp', 'plugin', { timeoutMs: 1_000 })).toMatchObject({ exitCode: 0 })
  expect(loader.loads).toBe(1)
  expect(await operations.readProfileRegistry('/tmp', { timeoutMs: 1_000 })).toBe('https://registry.example')
  expect(loader.loads).toBe(1)
  expect(connection.checkGithubConnection).toBeTypeOf('function')
})
