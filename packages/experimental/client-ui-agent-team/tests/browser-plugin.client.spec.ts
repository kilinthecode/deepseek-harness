import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RoomFollowFrame, RoomProposalView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type {} from '@deepseek-ai/dsh-experimental-agent-team/remote'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { TeamAction, type TeamActionInjected } from '../src/client/TeamAction.tsx'
import { TeamSubjectSeat, type TeamSubjectInjected } from '../src/client/TeamSubjectSeat.tsx'
import { inject, mountAgentTeamUi } from '../src/client/mount.ts'
import { apply as nodeApply } from '../src/index.ts'

const SESSION = 'team-session' as SessionId
const CHILD = 'team-child' as SessionId
const PROPOSAL = 'proposal-1' as RoomProposalView['id']
const REMOTE: TypertRemoteContribution = {
  package: '@deepseek-ai/dsh-experimental-agent-team',
  descriptors: [],
}
const ROOM = { enabled: true, participants: [], chair: 'lead', messages: [], proposals: [] }

/** Read one injected callback from the registered header action. */
function injectedAction<K extends keyof TeamActionInjected>(
  injected: Record<string, unknown>,
  key: K,
): TeamActionInjected[K] {
  const action = injected[key]
  if (typeof action !== 'function') throw new Error(`Team header action lacks its injected ${key} callback`)
  return action as TeamActionInjected[K]
}

async function bench(options: {
  addressed?: boolean
  registrationFailure?: boolean
  roomFailure?: boolean
  /** Settled `commands.execute` value: an execution, `undefined` for an unknown command, or a carrier failure. */
  command?: { kind: 'success' } | { kind: 'error'; text: string } | 'unknown' | 'failure'
} = {}) {
  const ctx = new Context()
  const calls: { method: string; args: unknown[] }[] = []
  const answer = <T>(method: string, value: T) => (...args: unknown[]) => {
    calls.push({ method, args })
    return Promise.resolve({ ok: true as const, value })
  }
  class RemoteService extends Service {
    readonly disposeMount = vi.fn(() => Promise.resolve())
    readonly mount = vi.fn((_contribution: unknown) => Promise.resolve(this.disposeMount))

    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }

    $mount(contribution: unknown): Promise<() => Promise<void>> {
      return this.mount(contribution)
    }
  }
  const remote = new RemoteService(ctx)
  const failure = {
    ok: false as const,
    error: new RemoteError('gateway/internal', 'offline', {}),
  }
  ctx.provide('remote.agentTeams', {
    room: (...args: unknown[]) => {
      calls.push({ method: 'agentTeams/room', args })
      return Promise.resolve(options.roomFailure === true ? failure : { ok: true as const, value: ROOM })
    },
    roomStream: (...args: unknown[]) => {
      calls.push({ method: 'agentTeams/roomStream', args })
      return (async function* (): AsyncGenerator<RoomFollowFrame> {
        yield { type: 'stream', participant: 'worker', delta: 'thinking' }
      })()
    },
    roomPrompt: answer('agentTeams/roomPrompt', { messageId: 'message-1', status: 'accepted' as const }),
    roomPropose: answer('agentTeams/roomPropose', { id: PROPOSAL }),
    roomEscalate: answer('agentTeams/roomEscalate', { id: PROPOSAL }),
  })
  ctx.provide('remote.commands', {
    execute: (...args: unknown[]) => {
      calls.push({ method: 'commands/execute', args })
      const command = options.command ?? { kind: 'success' }
      if (command === 'failure') return Promise.resolve(failure)
      return Promise.resolve({
        ok: true as const,
        value: command === 'unknown' ? undefined : { commandId: 'command-1', result: command },
      })
    },
  })
  const navigation: unknown[] = []
  let mainSessionId = options.addressed === true ? CHILD : SESSION
  ctx.provide('sessions', {
    binding: (id: SessionId) => options.addressed === true && id === CHILD
      ? { session: { getSnapshot: () => ({
        subagent: {
          address: {
            parentSessionId: SESSION,
            childSessionId: CHILD,
            mode: 'continuable' as const,
          },
        },
      }) } }
      : undefined,
    refreshProjections: (id: SessionId) => {
      navigation.push(['refresh', id])
      return Promise.resolve()
    },
    retainInfo: (id: SessionId) => ({
      getSnapshot: () => ({
        referenceCount: id === mainSessionId ? 1 : 0,
        retainedBy: id === mainSessionId ? { mainView: 1 } : {},
      }),
      subscribe: () => () => {},
    }),
  })
  ctx.provide('uiWorkspace', {
    openSession: (target: unknown) => { navigation.push(['open', target]) },
  } as never)
  ctx.provide('conversation', {})
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  const collapseHeader = ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  if (options.registrationFailure === true) {
    vi.spyOn(ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot registration failed') })
  }
  const fiber = options.registrationFailure === true
    ? ctx.plugin({ apply() {} })
    : ctx.plugin({ inject: [...inject], apply: clientCtx => mountAgentTeamUi(clientCtx, REMOTE) })
  const activation: Promise<unknown> = options.registrationFailure === true
    ? mountAgentTeamUi(ctx, REMOTE).catch((error: unknown) => error)
    : fiber.await()
  if (options.registrationFailure !== true) {
    await activation
  } else {
    await fiber.await()
  }
  const entry = () => ctx.slots.entries('conversation.session.header.actions')
    .find(candidate => candidate.component === TeamAction)
  const startEntry = () => ctx.slots.entries('conversation.input.dock')
    .find(candidate => candidate.component === TeamSubjectSeat)
  const startTeam = (sessionId: SessionId): TeamSubjectInjected['startTeam'] => {
    // Session-scoped entries receive the conversation id their slot instance renders.
    const inject = startEntry()!.inject! as (id: SessionId) => Record<string, unknown>
    const injected = inject(sessionId)
    const start = injected['startTeam']
    if (typeof start !== 'function') throw new Error('Team start strip lacks its injected startTeam callback')
    return start as TeamSubjectInjected['startTeam']
  }
  const actions = (): TeamActionInjected => {
    const injected = entry()!.inject!()
    return {
      openTeammate: injectedAction(injected, 'openTeammate'),
      loadRoom: injectedAction(injected, 'loadRoom'),
      followRoom: injectedAction(injected, 'followRoom'),
      promptParticipant: injectedAction(injected, 'promptParticipant'),
      proposeDecision: injectedAction(injected, 'proposeDecision'),
      escalateDecision: injectedAction(injected, 'escalateDecision'),
    }
  }
  return {
    ctx,
    fiber,
    activation,
    calls,
    navigation,
    remote,
    entry,
    startEntry,
    startTeam,
    actions,
    collapseHeader,
    select: (sessionId: SessionId) => { mainSessionId = sessionId },
  }
}

describe('ui-team browser plugin', () => {
  it('registers one disposable header action and mounts the room Remote contribution', async () => {
    const b = await bench()
    expect(inject).toEqual(['sessions', 'uiWorkspace', 'remote', 'slots', 'locale'])
    expect(b.entry()).toMatchObject({
      options: { id: 'agent-team', order: -20 },
      locale: 'agent-team',
    })
    expect(b.remote.mount).toHaveBeenCalledOnce()
    expect(b.remote.mount).toHaveBeenCalledWith(REMOTE)
    const t = b.ctx.locale.bind('agent-team')
    expect(t('trigger')).toBe('Agent Team')

    expect(b.navigation).toEqual([])
    expect(b.calls).toEqual([])

    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
    expect(b.startEntry()).toBeUndefined()
    expect(b.remote.disposeMount).toHaveBeenCalledOnce()
    expect(t('empty')).toBe('empty')
  })

  it('unmounts the Remote contribution when later Client registration fails', async () => {
    const b = await bench({ registrationFailure: true })
    await expect(b.activation).resolves.toMatchObject({ message: 'slot registration failed' })
    expect(b.remote.mount).toHaveBeenCalledOnce()
    expect(b.remote.disposeMount).toHaveBeenCalledOnce()
  })

  it('routes every room action from an addressed teammate conversation through its Lead', async () => {
    const b = await bench({ addressed: true })
    const actions = b.actions()
    expect(await actions.loadRoom(CHILD)).toEqual({ ok: true, value: ROOM })
    const controller = new AbortController()
    const frames: RoomFollowFrame[] = []
    await actions.followRoom(CHILD, controller.signal, (frame) => { frames.push(frame) })
    expect(frames).toEqual([{ type: 'stream', participant: 'worker', delta: 'thinking' }])
    expect((await actions.promptParticipant(CHILD, { target: 'worker', instruction: 'Review the diff' })).ok).toBe(true)
    expect((await actions.proposeDecision(CHILD, { statement: 'Adopt the cache' })).ok).toBe(true)
    expect((await actions.escalateDecision(CHILD, { proposalId: PROPOSAL, reason: 'No quorum' })).ok).toBe(true)
    expect(b.calls).toEqual([
      { method: 'agentTeams/room', args: [SESSION] },
      { method: 'agentTeams/roomStream', args: [SESSION, controller.signal] },
      { method: 'agentTeams/roomPrompt', args: [SESSION, { target: 'worker', instruction: 'Review the diff' }] },
      { method: 'agentTeams/roomPropose', args: [SESSION, { statement: 'Adopt the cache' }] },
      { method: 'agentTeams/roomEscalate', args: [SESSION, { proposalId: PROPOSAL, reason: 'No quorum' }] },
    ])
  })

  it('returns room Remote carrier failures unchanged', async () => {
    const b = await bench({ roomFailure: true })
    await expect(b.actions().loadRoom(SESSION)).resolves.toMatchObject({
      ok: false,
      error: { code: 'gateway/internal', message: 'offline' },
    })
  })

  it('opens a continuable teammate address without touching the parent catalog', async () => {
    const b = await bench()
    b.actions().openTeammate(SESSION, CHILD)
    expect(b.navigation).toEqual([
      ['open', { parentSessionId: SESSION, childSessionId: CHILD, mode: 'continuable' }],
    ])
  })

  it('routes teammate navigation from an addressed teammate conversation back through its Lead', async () => {
    const b = await bench({ addressed: true })
    b.actions().openTeammate(CHILD, CHILD)
    expect(b.navigation).toEqual([
      ['open', { parentSessionId: SESSION, childSessionId: CHILD, mode: 'continuable' }],
    ])
  })

  it('opens the Lead from an addressed teammate conversation', async () => {
    const b = await bench({ addressed: true })
    b.actions().openTeammate(CHILD, SESSION)
    expect(b.navigation).toEqual([['open', SESSION]])
  })

  it('does not open a teammate from a conversation outside the main view', async () => {
    const b = await bench()
    b.select('other-session' as SessionId)
    b.actions().openTeammate(SESSION, CHILD)
    expect(b.navigation).toEqual([])
  })

  it('re-registers after the conversation header slot is collapsed and declared again', async () => {
    const b = await bench()
    expect(b.entry()).toBeDefined()
    b.collapseHeader()
    expect(b.entry()).toBeUndefined()
    b.ctx.slots.register({
      name: 'root',
      children: { 'conversation.session.header.actions': { kind: 'list', scope: 'session' } },
    } as never, () => null)
    await Promise.resolve()
    expect(b.entry()).toBeDefined()
  })

  it('registers the start strip in the composer dock ahead of the Todo and Goal cards', async () => {
    const b = await bench()
    expect(b.startEntry()).toMatchObject({
      options: { id: 'agent-team-subject', order: -10 },
      locale: 'agent-team',
    })
  })

  it('starts a Team through the /team command of the conversation it was injected for', async () => {
    const b = await bench()
    await expect(b.startTeam(SESSION)('Ship the parser')).resolves.toEqual({ kind: 'started' })
    expect(b.calls).toEqual([{ method: 'commands/execute', args: [SESSION, '/team Ship the parser', []] }])
  })

  it.each([
    [{ kind: 'error', text: 'subject exceeds 200 characters' }, { kind: 'refused', text: 'subject exceeds 200 characters' }],
    ['unknown', { kind: 'unavailable' }],
    ['failure', { kind: 'refused', text: 'offline' }],
  ] as const)('maps the command outcome %j to %j', async (command, expected) => {
    const b = await bench({ command })
    await expect(b.startTeam(SESSION)('Ship')).resolves.toEqual(expected)
  })

  it('keeps the node half inert', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
