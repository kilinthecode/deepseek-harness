/** Recorded npm evidence stays intact while authored files and exact edits remain checked. */

import { describe, expect, it } from 'vitest'
import { exactEditState, isRescopeExcluded, rewriteRescopeReferences } from './rescope-vendor.ts'

const ANCHOR = '\n## Sync procedure'
const INSERTED = `\n15. **rescope**: one log entry.\n${ANCHOR}`

describe('rescope file selection', () => {
  it('preserves the recorded npm resolution', () => {
    expect(isRescopeExcluded('scripts/dependency-catalog/package-lock.json')).toBe(true)
  })

  it.each([
    'scripts/dependency-catalog/package.json',
    'scripts/dependency-catalog/source.ts',
    'scripts/other/package-lock.json',
    'packages/example/src/index.ts',
    'packages/example/package.json',
  ])('keeps %s subject to upstream package-name checks', (file) => {
    expect(isRescopeExcluded(file)).toBe(false)
  })
})

describe('exactEditState', () => {
  it('classifies an insertion by its target form, so a duplicate is invalid', () => {
    expect(exactEditState(`log\n${ANCHOR}\n`, ANCHOR, INSERTED, 1)).toBe('pending')
    expect(exactEditState(`log${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('applied')
    // The anchor survives an insertion, so counting the source form would have
    // called this pending and inserted the entry a second time.
    expect(exactEditState(`log${INSERTED}${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('invalid')
    expect(exactEditState('log\n', ANCHOR, INSERTED, 1)).toBe('invalid')
  })

  it('classifies a deletion by its source form, and requires its remainder to survive', () => {
    const remainder = 'exclude:\n'
    const withEntries = 'exclude:\n  - cordis@4\n'
    expect(exactEditState(withEntries, withEntries, remainder, 1)).toBe('pending')
    expect(exactEditState(remainder, withEntries, remainder, 1)).toBe('applied')
    // Upstream dropped the whole field: the source form is gone, but so is the
    // remainder, so this is a moved site rather than a completed deletion.
    expect(exactEditState('unrelated:\n', withEntries, remainder, 1)).toBe('invalid')
  })

  it('requires a replacement to leave no source form and the exact target count', () => {
    expect(exactEditState('a = 1\n', 'a = 1', 'b = 2', 1)).toBe('pending')
    expect(exactEditState('b = 2\n', 'a = 1', 'b = 2', 1)).toBe('applied')
    expect(exactEditState('b = 2\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    // A moved or partially applied site: neither state is complete.
    expect(exactEditState('a = 1\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    expect(exactEditState('x\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
  })
})

// Split pre-rescope fixtures so the codemod can scan its own test source.
const FRAMEWORK = 'cor' + 'dis'
const SCHEMA = 'schema' + 'stery'

describe('runtime identifiers in package-reference files', () => {
  it.each([
    'docs/subsystems/schedule.md',
    'docs/subsystems/schedule.zh.md',
    'docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.md',
    'docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.zh.md',
    'docs/user/guide/schedule.md',
    'docs/user/guide/schedule.zh.md',
  ])('preserves the Cordis preset id in %s while renaming another package', (file) => {
    const text = `The \`${FRAMEWORK}\` preset uses \`@deepseek-ai/cordis\` and \`${SCHEMA}\`.\n`
    expect(rewriteRescopeReferences(text, file)).toEqual({
      text: `The \`${FRAMEWORK}\` preset uses \`@deepseek-ai/cordis\` and \`@deepseek-ai/schemastery\`.\n`,
      lines: 1,
    })
  })

  it('preserves the Web roster preset id while renaming YAML package names', () => {
    const text = `# Tools belong to the \`standard\`, \`${FRAMEWORK}\`, and \`ptc\` presets.\n`
      + `- name: '@deepseek-ai/cordis'\n- name: ${SCHEMA}\n`
    expect(rewriteRescopeReferences(text, 'packages/bundle/web-app/cordis.patch.yml')).toEqual({
      text: `# Tools belong to the \`standard\`, \`${FRAMEWORK}\`, and \`ptc\` presets.\n`
        + "- name: '@deepseek-ai/cordis'\n- name: @deepseek-ai/schemastery\n",
      lines: 1,
    })
  })

  it.each([
    'packages/extensions/cordis-host-runner/tests/inspect-registry.spec.ts',
    'snapshots/session/cordis-inspect-liveness/client-fixture.mjs',
    'snapshots/session/cordis-inspect-timeout/client-fixture.mjs',
  ])('preserves Inspect event ids in %s while renaming another package', (file) => {
    const text = `import { Context } from '@deepseek-ai/cordis'\nimport Schema from '${SCHEMA}'\n`
      + `ctx.on('${FRAMEWORK}/inspect-query', listener)\nctx.on('${FRAMEWORK}/inspect-query-resolved', listener)\n`
    expect(rewriteRescopeReferences(text, file)).toEqual({
      text: "import { Context } from '@deepseek-ai/cordis'\nimport Schema from '@deepseek-ai/schemastery'\n"
        + `ctx.on('${FRAMEWORK}/inspect-query', listener)\nctx.on('${FRAMEWORK}/inspect-query-resolved', listener)\n`,
      lines: 1,
    })
  })

  it.each([
    ['packages/example/src/index.ts', `import { Context } from '${FRAMEWORK}'\nimport '${FRAMEWORK}/context'\n`, "import { Context } from '@deepseek-ai/cordis'\nimport '@deepseek-ai/cordis/context'\n"],
    ['docs/subsystems/schedule-new.md', `Use \`${FRAMEWORK}\`.\n`, 'Use `@deepseek-ai/cordis`.\n'],
    ['packages/bundle/example/cordis.patch.yml', `name: ${FRAMEWORK}\n`, 'name: @deepseek-ai/cordis\n'],
  ])('continues renaming framework references in %s', (file, text, expected) => {
    expect(rewriteRescopeReferences(text, file).text).toBe(expected)
  })
})
