/** The packaged-skill provider helper, through the real registry. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, {
  BUNDLED_SKILL_RANK,
  bundledSkillProvider,
  type SkillCandidate,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A package-shaped directory: an `assets/` folder holding the skill body file. */
function packagedSkill(body: string): { bodyUrl: URL; assetsUrl: URL; assetsPath: string; bodyPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bundled-skill-'))
  roots.push(root)
  const assetsPath = join(root, 'assets')
  mkdirSync(assetsPath)
  const bodyPath = join(assetsPath, 'crew.md')
  writeFileSync(bodyPath, body)
  const assetsUrl = pathToFileURL(`${assetsPath}/`)
  return {
    bodyUrl: pathToFileURL(bodyPath),
    assetsUrl,
    // The directory URL ends in a separator, and so does the resource base derived from it.
    assetsPath: fileURLToPath(assetsUrl),
    bodyPath,
  }
}

describe('bundledSkillProvider', () => {
  it('lists one candidate named for the provider, invocable by model and user, at the bundled rank', async () => {
    const { bodyUrl, assetsUrl, assetsPath } = packagedSkill('# Crew\n')
    const provider = bundledSkillProvider({ name: 'crew', description: 'Run a crew.', body: bodyUrl, resources: assetsUrl })

    expect(provider.name).toBe('crew')
    const candidates = await provider.list({})
    expect(candidates).toEqual([{
      name: 'crew',
      description: 'Run a crew.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'crew',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: assetsPath },
      rank: BUNDLED_SKILL_RANK,
      locator: bodyUrl,
    }])
    expect(BUNDLED_SKILL_RANK).toBe(600)
  })

  it('reads the body file each time the skill loads', async () => {
    const { bodyUrl, assetsUrl, bodyPath } = packagedSkill('first body\n')
    const provider = bundledSkillProvider({ name: 'crew', description: 'Run a crew.', body: bodyUrl, resources: assetsUrl })
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    ctx.skills.registerProvider(() => provider)

    expect((await ctx.skills.get('crew'))?.content).toBe('first body\n')
    writeFileSync(bodyPath, 'second body\n')
    expect((await ctx.skills.get('crew'))?.content).toBe('second body\n')
    await ctx.fiber.dispose()
  })

  it('serves the definition the registry lists, with the assets directory as its resource base', async () => {
    const { bodyUrl, assetsUrl, assetsPath } = packagedSkill('# Crew\n')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    ctx.skills.registerProvider(() => bundledSkillProvider({ name: 'crew', description: 'Run a crew.', body: bodyUrl, resources: assetsUrl }))

    expect(await ctx.skills.list()).toEqual([{
      name: 'crew',
      description: 'Run a crew.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'crew',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: assetsPath },
    }])
    expect(await ctx.skills.get('crew')).toMatchObject({
      name: 'crew',
      provider: 'crew',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: assetsPath },
      content: '# Crew\n',
    })
    await ctx.fiber.dispose()
  })

  it('yields to a same-named skill from a provider ranked above the bundled one', async () => {
    const { bodyUrl, assetsUrl } = packagedSkill('bundled body\n')
    const projectCandidate: SkillCandidate = {
      name: 'crew',
      description: 'The project\'s own crew skill.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'project',
      source: 'project-dsh',
      rank: BUNDLED_SKILL_RANK - 100,
      locator: undefined,
    }
    const project: SkillProvider = {
      name: 'project',
      list: () => Promise.resolve([projectCandidate]),
      get: candidate => Promise.resolve({ ...candidate, content: 'project body\n' }),
    }
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    ctx.skills.registerProvider(() => bundledSkillProvider({ name: 'crew', description: 'Run a crew.', body: bodyUrl, resources: assetsUrl }))
    ctx.skills.registerProvider(() => project)

    expect((await ctx.skills.get('crew'))?.content).toBe('project body\n')
    await ctx.fiber.dispose()
  })
})
