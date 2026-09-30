// Keyless assembled-browser coverage for the room profile layer's Agent Teams
// Web panel: the transcript and the decision board render through the real
// Host Typert Remote flow.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { RoomMessageId, RoomProposalId, TeamId } from '@deepseek-ai/dsh-experimental-agent-team'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/agent-room-panel', import.meta.url))
const PANEL_EXPECTED = join(SNAPSHOT_DIR, 'room.expected.md')
const OVERLAY = fileURLToPath(new URL('./agent-room-panel.overlay.yml', import.meta.url))
const ROOM_PATCH = fileURLToPath(new URL('../../../packages/experimental/agent-room-profile/cordis.patch.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/agent-room-profile/package.json', import.meta.url)),
]
const MODE = webSnapshotMode()
const WORKER = SessionId('room-worker')

function profileEntries(path: string): unknown[] {
  const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`profile layer at ${path} must be a list`)
  return parsed
}

describe('Agent room panel overlay', () => {
  it('matches the shipped room profile layer', () => {
    expect(profileEntries(OVERLAY)).toEqual(profileEntries(ROOM_PATCH))
  })
})

describe('web e2e: Agent room panel', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  /** Lead Session whose room the panel follows. */
  let session: Session

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('connected room workspace did not create an Agent')
    session = agent.session
    const teamId = TeamId(session.header.id)
    const member = {
      id: WORKER,
      name: 'worker',
      description: 'skeptical reviewer',
      provider: 'spawn',
      context: 'fresh' as const,
      agentProvider: 'fixture',
      agentModel: 'reviewer-model',
    }
    // One conversation turn so the panel's host action has a place to render.
    // It precedes the Team's first teammate, so the room does not transcribe it.
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Open the room.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'Room ready.' }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // A durable participant, then the room records a decision that quorum settles.
    session.append('team/member', { version: 2, teamId, member: { ...member, phase: 'provisioning' } })
    session.append('team/member', { version: 2, teamId, member: { ...member, phase: 'active' } })
    session.append('room/message', {
      version: 1,
      teamId,
      message: {
        id: RoomMessageId('room-message-fixture'),
        authorId: WORKER,
        content: [{ type: 'text', text: 'an uninvalidated cache serves stale reads' }],
      },
    })
    session.append('room/proposal', {
      version: 1,
      teamId,
      proposal: {
        id: RoomProposalId('proposal-1'),
        revision: 1,
        proposerId: session.header.id,
        statement: 'Adopt a global mutable cache with no invalidation.',
        phase: 'open',
      },
    })
    session.append('room/review', {
      version: 1,
      teamId,
      review: {
        proposalId: RoomProposalId('proposal-1'),
        proposalRevision: 1,
        reviewerId: WORKER,
        verdict: 'reject',
        reason: 'stale reads are a correctness bug',
      },
    })
    session.append('room/proposal', {
      version: 1,
      teamId,
      proposal: {
        id: RoomProposalId('proposal-1'),
        revision: 1,
        proposerId: session.header.id,
        statement: 'Adopt a global mutable cache with no invalidation.',
        phase: 'rejected',
      },
    })
    await scaffold.ctx.sessions.flush(session)
    await page.getByText('Room ready.').waitFor({ timeout: 10_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders the room transcript and the settled decision', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-room-panel'))
    await page.locator('[data-team-action]').getByRole('button', { name: /Agent Team/iu }).click()
    // The panel renders in a portal dialog outside the header action.
    const action = page.getByRole('dialog', { name: 'Agent Team', exact: true })
    await action.getByText('an uninvalidated cache serves stale reads').waitFor()
    await action.getByText('Adopt a global mutable cache with no invalidation.').waitFor()
    // The phase chip and the standing line both name the verdict, so match the chip exactly.
    await action.getByText('Rejected', { exact: true }).waitFor()
    // A settled decision awaits nobody, and the vote names its reviewer.
    await action.getByText('Rejections: worker').waitFor()
    await action.getByText('Awaiting: None').waitFor()
    // The board carries the objection itself, not only the count against it.
    await action.getByText('worker · Rejected').waitFor()
    await action.getByText('stale reads are a correctness bug').waitFor()

    const snapshot = await captureStableAria(page, '[data-team-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(PANEL_EXPECTED, snapshot, MODE)

    // A decision opened after the panel mounted arrives through the live room
    // follow: no refresh, no reload, and the durable record is what renders.
    await expect(action.getByText('Adopt a bounded cache with invalidation.').count()).resolves.toBe(0)
    const lead = scaffold.ctx.agents.get(session.header.id)
    if (lead === undefined) throw new Error('the room Lead is not live')
    await scaffold.ctx.agentTeams.roomPropose(lead, {
      statement: 'Adopt a bounded cache with invalidation.',
      signal: new AbortController().signal,
    })
    await action.getByText('Adopt a bounded cache with invalidation.').waitFor({ timeout: 10_000 })

    // The panel writes too: its own controls open a decision through the Remote
    // write path, and the committed record renders like any other.
    await action.getByPlaceholder('Statement to put to the room').fill('Adopt the panel-driven path.')
    await action.getByRole('button', { name: 'Open a decision', exact: true }).click()
    await action.getByText('Adopt the panel-driven path.').waitFor({ timeout: 10_000 })

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['room.expected.md'])
  })
})
