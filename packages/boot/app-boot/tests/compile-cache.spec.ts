import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { constants } from 'node:module'
import { enableDshCompileCache } from '../src/compile-cache.ts'

const cache = vi.hoisted(() => ({ enable: vi.fn(), available: true }))
vi.mock('node:module', async original => ({
  constants: (await original<typeof import('node:module')>()).constants,
  get enableCompileCache() { return cache.available ? cache.enable : undefined },
}))
vi.mock('@deepseek-ai/dsh-home-paths', () => ({ dshCachePath: (name: string) => `/cache/${name}` }))
beforeEach(() => {
  cache.available = true
  cache.enable.mockReset().mockReturnValue({ status: constants.compileCacheStatus.ENABLED })
  vi.stubEnv('NODE_COMPILE_CACHE', undefined)
  vi.stubEnv('NODE_DISABLE_COMPILE_CACHE', undefined)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('uses the resolved home cache without requiring an installation write', async () => {
  await enableDshCompileCache('dsh', ['task'])
  expect(cache.enable).toHaveBeenCalledWith('/cache/node-compile-cache')
})
it.each(['NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE'])('respects %s even when empty', async (name) => {
  vi.stubEnv(name, '')
  await enableDshCompileCache('dsh', [])
  expect(cache.enable).not.toHaveBeenCalled()
})
it.each(['-V', '--version', '-h', '--help'])('keeps %s cache-free wherever it appears', async (flag) => {
  await enableDshCompileCache('dsh', ['task', flag])
  expect(cache.enable).not.toHaveBeenCalled()
})
it('permits runtimes without the compile-cache API', async () => {
  cache.available = false
  await enableDshCompileCache('dsh', [])
  expect(cache.enable).not.toHaveBeenCalled()
})
it.each(['read-only', undefined])('reports a FAILED cache status without blocking launch: %s', async (message) => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  cache.enable.mockReturnValue({ status: constants.compileCacheStatus.FAILED, message })
  await enableDshCompileCache('dsh', [])
  expect(diagnostic).toHaveBeenCalledOnce()
  expect(diagnostic).toHaveBeenCalledWith(`dsh: node compile cache disabled (${message ?? 'unknown failure'})`)
})
it.each([new Error('unavailable'), 'unavailable'])('contains cache API exceptions: %s', async (failure) => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  cache.enable.mockImplementation(() => { throw failure })
  await expect(enableDshCompileCache('dsh', [])).resolves.toBeUndefined()
  expect(diagnostic).toHaveBeenCalledWith('dsh: node compile cache disabled (unavailable)')
})
