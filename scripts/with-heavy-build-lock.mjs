/** Serialize local build and gate processes across checkouts; inherited children share the owner's lease. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import lockfile from 'proper-lockfile'

const lockPath = process.env.DSH_HEAVY_BUILD_LOCK_PATH ?? join(tmpdir(), `dsh-heavy-build-${process.getuid?.() ?? 'user'}`)
const cancellation = new AbortController()
let child
let ownsGroup = false
let terminated
let compromised
const terminate = signal => {
  terminated = signal
  cancellation.abort()
  if (child?.pid !== undefined) {
    try { process.kill(ownsGroup ? -child.pid : child.pid, signal) }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}
process.on('SIGINT', () => terminate('SIGINT'))
process.on('SIGTERM', () => terminate('SIGTERM'))
let release
try {
  if (!isAbsolute(lockPath)) throw new Error('DSH_HEAVY_BUILD_LOCK_PATH must be absolute')
  const inherited = process.env.DSH_HEAVY_BUILD_LOCK_OWNER
  const owner = inherited?.split(':', 1)[0]
  let sharesLease = false
  if (owner !== undefined && inherited === `${owner}:${lockPath}` && /^\d+$/.test(owner)) {
    try { process.kill(Number(owner), 0); sharesLease = true }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const hosted = process.env.CI === 'true' || process.env.CI === '1'
  if (!sharesLease && !hosted) {
    const target = await open(lockPath, 'a')
    await target.close()
    let announced = false
    while (release === undefined && !cancellation.signal.aborted) {
      try {
        release = await lockfile.lock(lockPath, {
          realpath: false, retries: 0,
          onCompromised(error) { compromised = error; terminate('SIGTERM') },
        })
      } catch (error) {
        if (error.code !== 'ELOCKED') throw error
        if (!announced) { process.stderr.write('Waiting for the other local build or gate to finish.\n'); announced = true }
        await delay(1000, undefined, { signal: cancellation.signal })
      }
    }
  }
  if (!cancellation.signal.aborted) {
    const [script, ...args] = process.argv.slice(2)
    let command
    let commandArgs
    if (script === '--') {
      if (args.length === 0) throw new Error('Heavy build wrapper requires a command')
      ;[command, ...commandArgs] = args
    } else {
      if (!script) throw new Error('Heavy build wrapper requires a package script')
      // The root's pinned pnpm supplies a JavaScript entry on every platform.
      const entry = join(dirname(createRequire(import.meta.url).resolve('pnpm')), 'bin/pnpm.mjs')
      command = process.execPath
      commandArgs = [entry, 'run', script, ...args]
    }
    const env = { ...process.env }
    if (release !== undefined) env.DSH_HEAVY_BUILD_LOCK_OWNER = `${process.pid}:${lockPath}`
    // Only the lease owner creates a process group; nested commands retain it.
    ownsGroup = process.platform !== 'win32' && !sharesLease
    child = spawn(command, commandArgs, { stdio: 'inherit', env, detached: ownsGroup })
    const [code, signal] = await once(child, 'close')
    if (compromised !== undefined) throw compromised
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143)
  } else { process.exitCode = terminated === 'SIGINT' ? 130 : 143 }
} catch (error) {
  if (cancellation.signal.aborted && compromised === undefined) process.exitCode = terminated === 'SIGINT' ? 130 : 143
  else { process.stderr.write(`Heavy build failed: ${error.message}\n`); process.exitCode = 1 }
} finally { await release?.() }
