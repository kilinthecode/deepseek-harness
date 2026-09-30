import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'

// Two ids the installed catalog does not ship, planted so the two refusals that
// keep a route from registering a sign-in it cannot run stay distinguishable in
// the log: `acme-gateway` names no installed provider at all, while
// `acme_gateway` names one whose id the credential record grammar refuses.
vi.mock('../src/catalog.ts', async (importOriginal) => {
  const catalog = await importOriginal<typeof import('../src/catalog.ts')>()
  const codex = catalog.catalogProvider('openai-codex')
  return {
    ...catalog,
    catalogProviderIds: () => [...catalog.catalogProviderIds(), 'acme-gateway', 'acme_gateway'],
    catalogProvider: (provider: string) => provider === 'acme_gateway' ? codex : catalog.catalogProvider(provider),
  }
})

const { credentialStoreFrom, authContextFrom } = await import('../src/auth.ts')
const { registerPiAiFlows } = await import('../src/login.ts')

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * Register every flow and return the warnings registration wrote, each `%s`
 * substituted so the assertion reads the line a maintainer sees in the log.
 * @returns the warnings in registration order.
 */
async function refusalWarnings(): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-refusal-'))
  dirs.push(dir)
  const ctx = new Context()
  // The authorization seam injects the credentials seam, so a refused entry
  // costs a warning on a context otherwise composed like a real mount.
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  const warnings: string[] = []
  ctx.logger.warn = ((message: string, providerId: string) => {
    warnings.push(message.replace('%s', providerId))
  }) as typeof ctx.logger.warn
  registerPiAiFlows(ctx, { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) })
  return warnings
}

describe('pi-ai flow registration refusals', () => {
  it('names the missing login when the installed catalog ships no runnable method', async () => {
    expect(await refusalWarnings()).toContain(
      'llm-pi-ai: catalog provider "acme-gateway" offers no login method this plugin can run;'
      + ' its sign-in is not offered')
  })

  it('names the unaddressable record when the provider id is outside the credential grammar', async () => {
    expect(await refusalWarnings()).toContain(
      'llm-pi-ai: catalog provider "acme_gateway" cannot address a credential record; its sign-in is not offered')
  })
})
