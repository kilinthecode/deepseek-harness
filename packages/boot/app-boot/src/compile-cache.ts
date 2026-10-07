/**
 * Best-effort Node module compile cache for the launcher processes.
 *
 * The cache only stores V8 bytecode for modules this process already compiled,
 * and Node keys every entry by source content and Node version, so an entry is
 * never reused for different code. It lives beside the rest of the user-local
 * caches under the resolved Harness home — never inside the installed package
 * or an ASAR archive — so a read-only installation still gets a warm cache.
 * @module @deepseek-ai/dsh-app-boot/compile-cache
 */

import { dshCachePath } from '@deepseek-ai/dsh-home-paths'

/** Harness-home cache directory holding Node's per-version module compile cache. */
export const COMPILE_CACHE_DIR_NAME = 'node-compile-cache'

/**
 * Point Node's module compile cache at the Harness home.
 *
 * Only a launcher entry point calls this: a plugin must not change
 * process-wide module caching. An explicit `NODE_COMPILE_CACHE` or
 * `NODE_DISABLE_COMPILE_CACHE` keeps Node's own precedence, so a deployment
 * choice always wins. Every failure — an unwritable home, a cache volume Node
 * refuses — is reported as one diagnostic line and leaves the launch working
 * without a cache. A runtime without the API skips the attempt.
 * An invocation carrying a help or version flag answers without compiling a profile,
 * so it stays cache-free wherever the flag appears.
 * @param executableName - the calling executable's display name for that diagnostic.
 * @param args - the command-line arguments after the entry script.
 * @returns a promise that settles once the attempt is done; it never rejects.
 */
export async function enableDshCompileCache(executableName: string, args: readonly string[]): Promise<void> {
  if (process.env.NODE_COMPILE_CACHE !== undefined || process.env.NODE_DISABLE_COMPILE_CACHE !== undefined) return
  if (args.some(arg => arg === '-V' || arg === '--version' || arg === '-h' || arg === '--help')) return
  try {
    // A dynamic import keeps this module loadable on a runtime that predates
    // the API, where the property is absent instead of a link-time failure.
    const { constants, enableCompileCache } = await import('node:module')
    if (typeof enableCompileCache !== 'function') return
    // Node reports an unusable cache directory through the returned status, not by throwing.
    const result = enableCompileCache(dshCachePath(COMPILE_CACHE_DIR_NAME))
    if (result.status === constants.compileCacheStatus.FAILED) {
      console.error(`${executableName}: node compile cache disabled (${result.message ?? 'unknown failure'})`)
    }
  } catch (error) {
    console.error(`${executableName}: node compile cache disabled (${error instanceof Error ? error.message : String(error)})`)
  }
}
