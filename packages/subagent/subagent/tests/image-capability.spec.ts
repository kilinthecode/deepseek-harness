import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { assertImageCapableRoute } from '../src/image-capability.ts'

type ResolveModelInfo = (provider: string, model: string, signal: AbortSignal) => Promise<{ inputModalities?: string[] }>

/** Real Context with `llm` provided only when a resolver is supplied. */
function contextWithLlm(resolveModelInfo?: ResolveModelInfo): Context {
  const ctx = new Context()
  if (resolveModelInfo !== undefined) ctx.provide('llm', { resolveModelInfo } as never)
  return ctx
}

describe('assertImageCapableRoute', () => {
  const signal = new AbortController().signal

  it('proceeds when the provider or model is unresolved', async () => {
    const resolveModelInfo = () => { throw new Error('must not resolve model info without a route') }
    await expect(assertImageCapableRoute(contextWithLlm(resolveModelInfo), undefined, 'model', signal))
      .resolves.toBeUndefined()
    await expect(assertImageCapableRoute(contextWithLlm(resolveModelInfo), 'provider', undefined, signal))
      .resolves.toBeUndefined()
  })

  it('proceeds when no llm service is registered', async () => {
    await expect(assertImageCapableRoute(contextWithLlm(), 'provider', 'model', signal)).resolves.toBeUndefined()
  })

  it('proceeds when the route never disclosed its input modalities', async () => {
    const ctx = contextWithLlm(async () => ({}))
    await expect(assertImageCapableRoute(ctx, 'provider', 'model', signal)).resolves.toBeUndefined()
  })

  it('proceeds when the declared modalities include image', async () => {
    const ctx = contextWithLlm(async () => ({ inputModalities: ['text', 'image'] }))
    await expect(assertImageCapableRoute(ctx, 'provider', 'model', signal)).resolves.toBeUndefined()
  })

  it('refuses a route whose declared modalities omit image', async () => {
    const ctx = contextWithLlm(async () => ({ inputModalities: ['text'] }))
    await expect(assertImageCapableRoute(ctx, 'provider', 'gpt', signal)).rejects.toMatchObject({
      code: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
      message: 'Model "gpt" does not support image input.',
    })
  })
})
