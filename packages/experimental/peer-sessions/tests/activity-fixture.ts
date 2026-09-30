/**
 * Fixture for the activity-snapshot specs.
 *
 * The caller is a real session from {@link mountPeerHarness}; every peer is a
 * row another process would publish, written through the production
 * `writeActivity` so the reader validates exactly what that process writes.
 */

import { expect, vi } from 'vitest'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  PEER_ACTIVITY_VERSION,
  readActivity,
  removeActivity,
  writeActivity,
  type PeerActivityRecord,
} from '../src/activity.ts'
import type { PeerActivitySnapshot, PeerStatus } from '../src/index.ts'
import type { PeerHarness } from './harness.ts'

/** One peer row a test publishes, as another process would. */
export interface PeerRowSeed {
  /** Session id of the peer. */
  readonly id: string
  /** Display name the peer chose; the session id when a test does not care. */
  readonly name?: string
  /** Liveness the peer publishes; idle when a test does not say. */
  readonly status?: PeerStatus
  /** The peer's current line of work; the row carries no `doing` when a test leaves it out. */
  readonly doing?: string
  /** Checkout root the peer works in; the caller's own by default. */
  readonly root?: string
  /** Repository key the row carries; the caller's repository by default. */
  readonly repoKey?: string
  /** Recorded path keys, oldest first. */
  readonly files?: readonly string[]
  /** How long ago every write was reported; `0` (now) by default. */
  readonly fileAgeMs?: number
  /** How long ago the peer last published; `0` (now) by default. */
  readonly updatedAgoMs?: number
}

/** One snapshot a test pretends an earlier step was shown. */
export interface SeededSnapshot {
  /** Complete text of the message the earlier step logged. */
  readonly text: string
  /** Its named sections; the `peer:overlap` ones drive the later-step dedupe. */
  readonly sections: readonly ContextSnapshotSection[]
  /** Ids of the peers that message listed; a later step lists any peer outside them. */
  readonly peerIds: readonly SessionId[]
}

/** One peer as the block's JSON carries it. */
export interface BlockPeer {
  readonly name: string
  readonly status: string
  readonly doing?: string | undefined
  readonly checkout: string
  readonly files?: readonly string[] | undefined
}

/** One decoded peer block. */
export interface PeerBlock {
  readonly peers: readonly BlockPeer[]
  /** Whether the block dropped a peer or a peer field to fit its byte cap. */
  readonly truncated: boolean
}

/**
 * The block's exact shape, so a test reads a peer's fields and an unexpected
 * key fails the decode instead of passing unnoticed.
 */
const blockSchema = z.object({
  peers: z.array(z.object({
    name: z.string(),
    status: z.string(),
    doing: z.string().optional(),
    checkout: z.string(),
    files: z.array(z.string()).optional(),
  }).strict()),
  truncated: z.literal(true).optional(),
}).strict()

/** One calling session with the repository scope its peers are compared against. */
export interface SnapshotFixture {
  /** The calling agent. */
  readonly caller: Agent
  /** Canonical checkout root of the caller. */
  readonly root: string
  /** Repository key every listed peer carries. */
  readonly repoKey: string
  /** Render one step's snapshot, step 1 unless the test says otherwise. */
  snapshot(step?: number): Promise<PeerActivitySnapshot | undefined>
  /** Publish one peer row into this home. */
  write(seed: PeerRowSeed): Promise<void>
  /** Log the snapshot an earlier step showed, the way a real injection reaches the log. */
  seed(message: SeededSnapshot): Promise<void>
  /** Read one published row. */
  read(id: string): Promise<PeerActivityRecord | undefined>
  /** Retire one published row. */
  remove(id: string): Promise<void>
  /** Retire the calling session; a second call is a no-op. */
  dispose(): Promise<void>
}

/**
 * Wait for the row a session publishes when it is created.
 * @param harness - the mounted fixture.
 * @param id - the session whose row is awaited.
 * @returns the published row.
 */
async function publishedRow(harness: PeerHarness, id: string): Promise<PeerActivityRecord> {
  await vi.waitFor(async () => { expect(await readActivity(harness.home, id)).toBeDefined() })
  const row = await readActivity(harness.home, id)
  if (row === undefined) throw new Error(`${id} published no activity row`)
  return row
}

/**
 * Create one calling session and the peer-row writer scoped to its repository.
 * @param harness - the mounted fixture.
 * @param id - session id of the caller.
 * @param options - `cwd` when the caller works outside the harness workdir.
 * @returns the fixture the spec drives.
 */
export async function snapshotFixture(
  harness: PeerHarness,
  id: string,
  options: { readonly cwd?: string } = {},
): Promise<SnapshotFixture> {
  const handle = await harness.createHandle(id, options)
  const caller = handle.agent
  const row = await publishedRow(harness, id)
  let disposed = false
  return {
    caller,
    root: row.root,
    repoKey: row.repoKey,
    dispose: async () => {
      if (disposed) return
      disposed = true
      await handle.dispose()
    },
    snapshot: async (step = 1) => await harness.ctx.peers.activitySnapshot(caller, step),
    write: async (seed) => {
      const now = Date.now()
      const at = now - (seed.fileAgeMs ?? 0)
      const root = seed.root ?? row.root
      await writeActivity(harness.home, {
        version: PEER_ACTIVITY_VERSION,
        sessionId: SessionId(seed.id),
        repoKey: seed.repoKey ?? row.repoKey,
        root,
        cwd: root,
        name: seed.name ?? seed.id,
        status: seed.status ?? 'idle',
        pid: process.pid,
        updatedAt: now - (seed.updatedAgoMs ?? 0),
        ...seed.doing === undefined ? {} : { doing: seed.doing },
        files: (seed.files ?? []).map(p => ({ p, at })),
      })
    },
    seed: async (message) => {
      caller.followup(createUserMessage({
        content: [{ type: 'text', text: message.text }],
        source: { kind: 'peer-activity', form: 'snapshot', sections: message.sections, peerIds: message.peerIds },
      }))
      await caller.whenIdle()
    },
    read: async target => await readActivity(harness.home, target),
    remove: async (target) => { await removeActivity(harness.home, target) },
  }
}

/**
 * The decoded peer block of one rendered snapshot.
 * @param snapshot - the rendered snapshot.
 * @returns the parsed `peers` array of its `peer:activity` section.
 */
export function peerBlock(snapshot: PeerActivitySnapshot): PeerBlock {
  const section = snapshot.sections.find(candidate => candidate.name === 'peer:activity')
  if (section === undefined) throw new Error('the snapshot carries no peer block')
  const lines = section.text.split('\n')
  if (lines[1] !== '<peer-activity-json>' || lines.at(-1) !== '</peer-activity-json>') {
    throw new Error('the peer block is not wrapped in its own tags')
  }
  const parsed: unknown = JSON.parse(lines.slice(2, -1).join('\n'))
  const block = blockSchema.parse(parsed)
  return { peers: block.peers, truncated: block.truncated ?? false }
}

/**
 * The display names of one snapshot's listed peers, in order.
 * @param snapshot - the rendered snapshot.
 * @returns the names.
 */
export function peerNames(snapshot: PeerActivitySnapshot): readonly string[] {
  return peerBlock(snapshot).peers.map(peer => peer.name)
}

/**
 * Every `peer:overlap` section text of one rendered snapshot, in order.
 * @param snapshot - the rendered snapshot.
 * @returns the warning texts.
 */
export function overlapSections(snapshot: PeerActivitySnapshot): readonly string[] {
  return snapshot.sections.filter(section => section.name === 'peer:overlap').map(section => section.text)
}

/** The next turn number of one session, so every appended turn is a fresh one. */
const turns = new WeakMap<Agent, number>()

/**
 * Append one whole file-writing tool call and its result, the way the loop logs
 * them.
 *
 * The append is synchronous, so the service records the call in its in-process
 * state before the returned call yields: a test can then observe state that the
 * queued row publish has not carried to disk yet.
 * @param agent - the session whose log receives the call.
 * @param path - the model-facing path the write reports.
 * @param failed - whether the tool reports an error, as a file tool does for a write to a file changed since it was read.
 */
function appendWriteTurn(agent: Agent, path: string, failed: boolean): void {
  const turn = (turns.get(agent) ?? 0) + 1
  turns.set(agent, turn)
  const callId = `activity-${agent.id}-${turn}`
  agent.session.append('turn/start', { turn })
  agent.session.append('step/start', { turn, step: 1 })
  agent.session.append('tool/call', {
    turn,
    step: 1,
    callId: ToolCallId(callId),
    name: 'write',
    arguments: JSON.stringify({ file_path: path, content: 'x' }),
  })
  agent.session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text: failed ? 'file changed since it was read' : 'done' }],
      isError: failed,
    }),
  }, { surfaceOp: 'append' })
  agent.session.append('step/end', { turn, step: 1 })
  agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/**
 * Append one whole successful file-writing tool call.
 * @param agent - the session whose log receives the call.
 * @param path - the model-facing path the write reports.
 */
export function writeTurn(agent: Agent, path: string): void {
  appendWriteTurn(agent, path, false)
}

/**
 * Append one whole file-writing tool call whose result is an error.
 * @param agent - the session whose log receives the call.
 * @param path - the model-facing path the rejected write named.
 */
export function rejectedWriteTurn(agent: Agent, path: string): void {
  appendWriteTurn(agent, path, true)
}
