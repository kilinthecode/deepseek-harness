/**
 * Durable logged replay over one real room recording.
 *
 * The fixture is the Lead Session log harvested from a live `dsh --profile
 * headless` run of the room scenario: the Lead spawns `auditor-a`, opens a
 * decision, the auditor records a reasoned rejection, and the room settles it.
 * Replaying it through the projection proves the room's durable state — roster,
 * attributed transcript, decision, and the objection itself — reconstructs from
 * the committed log alone, without a provider, a timer, or a live Session.
 *
 * The recording is a Session format 3 log, and the fold reads its events
 * directly rather than through the Session format reader: the released V3-to-V4
 * migration refuses room events, so the reader cannot open this log
 * (docs/persistence-changes/2026-09-18-room-events.md).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { teamProjectionDefinition } from '../src/projection.ts'
import type { TeamProjectionState, TeamState } from '../src/projection.ts'

const RECORDING = join(import.meta.dirname, 'fixtures', 'room-deliberation.jsonl')

/** One JSONL line of the recording: the Session header or a committed event. */
type RecordedLine = SessionEvent | { readonly type: 'session'; readonly id: string; readonly version: number }

/** The recorded log: its header fields and every committed event. */
interface RecordedLog {
  readonly rootId: SessionId
  readonly version: number
  readonly events: readonly SessionEvent[]
}

/** The recorded log, split into its header and every committed event. */
function recordedLog(): RecordedLog {
  const records = readFileSync(RECORDING, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as RecordedLine)
  const header = records.find(record => record.type === 'session')
  if (header?.type !== 'session') throw new Error('room recording is missing its Session header')
  return {
    rootId: SessionId(header.id),
    version: header.version,
    events: records.filter((record): record is SessionEvent => record.type !== 'session'),
  }
}

/** Fold one recorded log into room state under its recorded header. */
function replay({ rootId, version, events }: RecordedLog): TeamProjectionState {
  let state = teamProjectionDefinition.init({
    version,
    id: rootId,
    createdAt: 0,
    isSeeded: false,
  })
  for (const event of events) state = teamProjectionDefinition.apply(state, event)
  return state
}

function teamState(projected: TeamProjectionState): TeamState {
  if (projected.failure !== undefined) throw new Error(projected.failure)
  return projected
}

describe('room durable replay', () => {
  it('reconstructs the deliberation from the recorded Lead Session alone', () => {
    const log = recordedLog()
    const { rootId } = log
    const projected = replay(log)
    expect(projected.failure).toBeUndefined()
    const state = teamState(projected)

    // The roster the recording recorded, with the transcript attributed to it.
    expect(state.members.map(member => [member.name, member.phase])).toEqual([['auditor-a', 'active']])
    const authors = [...new Set(state.roomMessages.map(message => message.authorId))]
    expect(authors).toHaveLength(2)
    expect(authors).toContain(rootId)
    expect(state.roomMessages[0]?.content).toEqual([
      { type: 'text', text: "I'll spawn the teammate and open the decision." },
    ])

    // The decision and the objection that settled it survive replay intact.
    expect(state.roomProposals.at(-1)).toMatchObject({
      id: 'proposal-1',
      revision: 1,
      proposerId: rootId,
      phase: 'rejected',
    })
    expect(state.roomReviews).toHaveLength(1)
    expect(state.roomReviews[0]).toMatchObject({ proposalId: 'proposal-1', proposalRevision: 1, verdict: 'reject' })
    expect(state.roomReviews[0]?.reason).toContain('unimplementable as written')
    expect(state.roomMessages.at(-1)?.content.flatMap(block =>
      block.type === 'text' ? [block.text] : []).join('')).toContain('**Phase:** rejected')
  })

  it('folds the same recording to the same state every time', () => {
    const log = recordedLog()
    expect(replay(log)).toEqual(replay(log))
  })
})
