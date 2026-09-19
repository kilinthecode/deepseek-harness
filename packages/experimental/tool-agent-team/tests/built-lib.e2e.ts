/** Plain-Node smoke for the built Agent Teams tool plugin bundle. */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(packageDir, '../../..')
const artifact = (path: string): string => join(root, path)
const artifactUrl = (path: string): string => pathToFileURL(artifact(path)).href

const requiredArtifact = 'packages/experimental/tool-agent-team/lib/index.js'

describe.skipIf(!existsSync(artifact(requiredArtifact)))('Agent Teams built LIB tools', () => {
  it('imports the built bundle and keeps the exported function plugin', async () => {
    // A bundle that keeps un-transpiled decorators or reaches a source-only
    // import fails to parse or resolve here, which is how a packaged install
    // silently loses every Team tool.
    const script = `
      const tools = await import(${JSON.stringify(artifactUrl(requiredArtifact))})
      console.log(JSON.stringify({
        apply: typeof tools.apply,
        name: tools.name,
        inject: Array.isArray(tools.inject),
        hasDefault: Object.hasOwn(tools, 'default'),
      }))
    `

    const result = await runPlainNode(script)
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0)
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      apply: string
      name: string
      inject: boolean
      hasDefault: boolean
    }
    expect(output).toEqual({
      apply: 'function',
      name: 'tool-agent-team',
      inject: true,
      hasDefault: false,
    })
  }, 30_000)
})

function runPlainNode(script: string): Promise<{
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}> {
  return new Promise((resolveRun) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], {
      cwd: packageDir,
      encoding: 'utf8',
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      resolveRun({
        exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
        stdout,
        stderr,
      })
    })
  })
}
