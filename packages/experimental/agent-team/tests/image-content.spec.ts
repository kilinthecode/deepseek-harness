import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { assertContinuableChildAcceptsImages } from '@deepseek-ai/dsh-subagent/internal'
import {
  admitTeamContent,
  assertTeamRouteAcceptsImages,
  assertTeamTargetAcceptsImages,
} from '../src/image-content.ts'

vi.mock(import('@deepseek-ai/dsh-subagent/internal'), async importOriginal => ({
  ...await importOriginal(),
  assertContinuableChildAcceptsImages: vi.fn(),
}))

const signal = new AbortController().signal

type ResolveModelInfo = (provider: string, model: string, s: AbortSignal) => Promise<{ inputModalities?: string[] }>

/** Real Context with `llm` provided only when a resolver is supplied. */
function contextWithLlm(resolveModelInfo?: ResolveModelInfo): Context {
  const ctx = new Context()
  if (resolveModelInfo !== undefined) ctx.provide('llm', { resolveModelInfo } as never)
  return ctx
}

/** Real Agent standing in for the Team Lead, for route-resolution tests. */
async function fakeRoot(provider: string, model: string, id = 'root-1'): Promise<Agent> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  return harness.create(SessionId(id), { provider, model })
}

describe('admitTeamContent', () => {
  it('strips offloaded from an image block while keeping every other field', () => {
    const content: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      {
        type: 'image',
        attachment: { attachmentId: 'a' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
        offloaded: true,
      },
    ]
    const admitted = admitTeamContent(content)
    expect(admitted).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
    ])
    expect('offloaded' in admitted[1]!).toBe(false)
  })

  it('leaves an image block without offloaded and non-image blocks unchanged', () => {
    const content: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'image', attachment: { attachmentId: 'b' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
    ]
    expect(admitTeamContent(content)).toEqual(content)
  })

  it('returns a detached clone independent of the source array', () => {
    const content: ContentBlock[] = [{ type: 'text', text: 'hello' }]
    const admitted = admitTeamContent(content)
    admitted.push({ type: 'text', text: 'mutated' })
    expect(content).toHaveLength(1)
  })
})

describe('assertTeamRouteAcceptsImages', () => {
  it('proceeds when the provider or model is unresolved, or no llm service is registered', async () => {
    const resolveModelInfo = () => { throw new Error('must not resolve model info without a route') }
    await expect(assertTeamRouteAcceptsImages(contextWithLlm(resolveModelInfo), undefined, 'model', signal))
      .resolves.toBeUndefined()
    await expect(assertTeamRouteAcceptsImages(contextWithLlm(resolveModelInfo), 'provider', undefined, signal))
      .resolves.toBeUndefined()
    await expect(assertTeamRouteAcceptsImages(contextWithLlm(), 'provider', 'model', signal)).resolves.toBeUndefined()
  })

  it('proceeds when the route is undeclared or declares image support', async () => {
    await expect(assertTeamRouteAcceptsImages(contextWithLlm(async () => ({})), 'provider', 'model', signal))
      .resolves.toBeUndefined()
    await expect(assertTeamRouteAcceptsImages(
      contextWithLlm(async () => ({ inputModalities: ['text', 'image'] })), 'provider', 'model', signal,
    )).resolves.toBeUndefined()
  })

  it('refuses a route whose declared modalities omit image', async () => {
    const ctx = contextWithLlm(async () => ({ inputModalities: ['text'] }))
    await expect(assertTeamRouteAcceptsImages(ctx, 'provider', 'gpt', signal)).rejects.toMatchObject({
      code: 'TEAM_IMAGES_UNSUPPORTED',
      message: 'Model "gpt" does not support image input.',
    })
  })
})

describe('assertTeamTargetAcceptsImages', () => {
  it('checks the Lead route directly when the target is the root', async () => {
    const ctx = contextWithLlm(async () => ({ inputModalities: ['text'] }))
    const root = await fakeRoot('mock', 'lead-model')
    await expect(assertTeamTargetAcceptsImages(ctx, root, root.id, signal)).rejects.toMatchObject({
      code: 'TEAM_IMAGES_UNSUPPORTED',
      message: 'Model "lead-model" does not support image input.',
    })
  })

  it('proceeds when the Lead route accepts image input', async () => {
    const ctx = contextWithLlm(async () => ({ inputModalities: ['text', 'image'] }))
    const root = await fakeRoot('mock', 'lead-model')
    await expect(assertTeamTargetAcceptsImages(ctx, root, root.id, signal)).resolves.toBeUndefined()
  })

  it('checks the Lead\'s live delegation route rather than its creation-time options', async () => {
    const resolveModelInfo = vi.fn().mockResolvedValue({ inputModalities: ['text'] })
    const ctx = contextWithLlm(resolveModelInfo)
    const root = await fakeRoot('mock', 'created-model')
    // The Lead's logged request header names a different model than its creation options.
    vi.spyOn(root.session, 'requestHeader').mockReturnValue({
      config: { provider: 'mock', model: 'switched-model' },
    })
    await expect(assertTeamTargetAcceptsImages(ctx, root, root.id, signal)).rejects.toMatchObject({
      code: 'TEAM_IMAGES_UNSUPPORTED',
      message: 'Model "switched-model" does not support image input.',
    })
    expect(resolveModelInfo).toHaveBeenCalledWith('mock', 'switched-model', signal)
  })

  it('delegates a teammate target to the subagent continuable-child probe', async () => {
    const ctx = contextWithLlm()
    const root = await fakeRoot('mock', 'lead-model')
    const targetId = SessionId('teammate-1')
    vi.mocked(assertContinuableChildAcceptsImages).mockResolvedValueOnce(undefined)

    await expect(assertTeamTargetAcceptsImages(ctx, root, targetId, signal)).resolves.toBeUndefined()
    expect(assertContinuableChildAcceptsImages).toHaveBeenCalledWith(ctx.subagents, root, targetId, signal)
  })

  it('remaps a teammate route refusal to a TeamError with the same message', async () => {
    const ctx = contextWithLlm()
    const root = await fakeRoot('mock', 'lead-model')
    const targetId = SessionId('teammate-2')
    vi.mocked(assertContinuableChildAcceptsImages).mockRejectedValueOnce(
      new SubagentError('Model "child-model" does not support image input.', 'MODEL_DOES_NOT_SUPPORT_IMAGES'),
    )

    await expect(assertTeamTargetAcceptsImages(ctx, root, targetId, signal)).rejects.toMatchObject({
      code: 'TEAM_IMAGES_UNSUPPORTED',
      message: 'Model "child-model" does not support image input.',
    })
  })

  it('propagates a teammate probe failure unrelated to image capability', async () => {
    const ctx = contextWithLlm()
    const root = await fakeRoot('mock', 'lead-model')
    const targetId = SessionId('teammate-3')
    const infra = new SubagentError('subagent unavailable', 'NOT_RESUMABLE')
    vi.mocked(assertContinuableChildAcceptsImages).mockRejectedValueOnce(infra)

    await expect(assertTeamTargetAcceptsImages(ctx, root, targetId, signal)).rejects.toBe(infra)
  })
})
