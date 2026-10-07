import { expect, it, vi } from 'vitest'
import { SdkLoad } from '../src/sdk-load.ts'

it.each([new Error('unavailable'), 'unavailable'])('normalizes a failed SDK import and permits a later retry: %s', async (failure) => {
  const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(failure).mockResolvedValue('sdk')
  const onFailure = vi.fn()
  const ready = vi.fn()
  const owner = new SdkLoad(load, onFailure)
  owner.start(ready)
  owner.start(ready)
  expect(owner.pending).toBe(true)
  await owner.settled()
  expect(owner.pending).toBe(false)
  expect(load).toHaveBeenCalledTimes(1)
  expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: 'unavailable' }))
  owner.start(ready)
  await owner.settled()
  expect(ready).toHaveBeenCalledWith('sdk')
  await owner.settled()
})
