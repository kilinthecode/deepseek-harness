// Keyless assembled-browser coverage for starting an Agent Team from the
// subject strip of a blank conversation over the shipped Team bundle.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const STRIP_EXPECTED = fileURLToPath(new URL('./snapshots/agent-team-start/strip.expected.md', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./agent-team-panel.overlay.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/agent-team-profile/package.json', import.meta.url)),
]
const MODE = webSnapshotMode()
const SUBJECT = 'Add a changelog entry for the parser'
const REPLY = 'Spawning a planner for the parser changelog.'

function reply(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 40, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function userTexts(events: readonly SessionEvent[]): { kind: string; text: string }[] {
  return events.flatMap(event => event.type === 'user/message'
    ? [{
      kind: event.data.source.kind,
      text: event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    }]
    : [])
}

describe('web e2e: starting an Agent Team from its subject', () => {
  let replayDir: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-agent-team-start-replay-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    const script: ReplayOverrideDoc = [{ kind: 'chunks', chunks: reply(REPLY) }]
    await writeFile(replayOverride, JSON.stringify(script))
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      extraInstallAnchors: INSTALL_ANCHORS,
      replayFixture: join(replayDir, 'override-only.jsonl'),
      replayOverride,
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (replayDir !== undefined) await rm(replayDir, { recursive: true, force: true })
  })

  it('names the conversation after the subject and starts the Lead on it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-start'))
    const strip = page.locator('[data-team-subject]')
    const field = strip.getByRole('textbox', { name: 'Team subject' })
    const start = strip.getByRole('button', { name: 'Start team' })
    await field.waitFor()
    expect(await start.isDisabled()).toBe(true)
    await field.fill(SUBJECT)
    await compareOrRefreshGolden(STRIP_EXPECTED, await captureStableAria(page, '[data-team-subject]', scaffold.workspaceCwd), MODE)

    await start.click()
    await page.getByText(REPLY).waitFor({ timeout: 30_000 })
    await strip.waitFor({ state: 'detached' })

    const lead = scaffold.ctx.agents.list()[0]!
    const events = lead.session.snapshotEvents()
    expect(events.find(event => event.type === 'team/subject')?.data).toMatchObject({ subject: SUBJECT })
    expect(events.find(event => event.type === 'session/title')?.data)
      .toMatchObject({ title: SUBJECT, source: { kind: 'user' } })
    // The conversation opens with the subject line as the user's own message.
    expect(userTexts(events).filter(entry => entry.kind === 'user')).toEqual([{ kind: 'user', text: SUBJECT }])

    // The panel of the started Team heads its roster with the subject.
    await page.locator('[data-team-action]').getByRole('button', { name: /Agent Team/iu }).click()
    const panel = page.getByRole('dialog', { name: 'Agent Team', exact: true })
    await panel.getByRole('heading', { name: 'Subject' }).waitFor()
    await panel.getByText(SUBJECT, { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})
