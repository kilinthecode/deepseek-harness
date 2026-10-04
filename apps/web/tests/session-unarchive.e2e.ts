// Archive and restore through sidebar row menus and the archived filter,
// then reload from the Host baseline. This flow makes no model calls.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, seedSession, watchConsole, type WebScaffold,
  compareOrRefreshGolden, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

// The seed is another scenario's committed fixture, reused read-only: this
// spec needs any one cold Session row, not new recorded content.
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const SEED_ID = 'session-unarchive-web-e2e'
const REFUSED_EXPECTED = fileURLToPath(new URL('./expected/session-unarchive/refused-actions.expected.md', import.meta.url))

describe('web e2e: archived sessions are restored from the sidebar filter', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  /**
   * Expand the Ungrouped group when it renders collapsed so its rows are
   * addressable, then return the section holding them.
   * @returns the expanded Ungrouped section locator.
   */
  async function ungroupedSection(): Promise<Locator> {
    const header = page.getByText('Ungrouped', { exact: true })
    const groupRow = header.locator('..').locator('..')
    await expect.poll(async () => {
      if (await groupRow.count() === 0) return 'absent'
      if (await groupRow.getAttribute('aria-expanded') !== 'true') {
        await header.click()
        return 'collapsed'
      }
      return 'expanded'
    }, { timeout: 15_000 }).toBe('expanded')
    return groupRow.locator('..')
  }

  /**
   * Reveal and click a row action, re-hovering if a projection update replaces
   * the row before its hover-only button becomes visible.
   * @param row - the row owning the action.
   * @param name - accessible name of the action button.
   */
  async function clickHoverAction(row: Locator, name: string): Promise<void> {
    const button = row.getByRole('button', { name })
    await expect.poll(async () => {
      await row.hover()
      return await button.isVisible()
    }, { timeout: 10_000 }).toBe(true)
    await button.click()
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // Seed one cold session; with no Workspace registered it is the sidebar's
    // only row, in the Ungrouped bucket.
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('archives the seed, restores it through the sidebar filter, and keeps it restored across reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-unarchive'))
    // Select the only visible Session, then give it a user-owned title: the
    // locator binds to the seed's own copy on both sides of the round trip.
    const seededRow = (await ungroupedSection()).locator('[role="treeitem"]')
      .filter({ has: page.locator('button[aria-label^="Session actions for "]') })
    await expect.poll(() => seededRow.count(), { timeout: 10_000 }).toBe(1)
    await seededRow.click()
    await expect.poll(() => seededRow.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')
    const { title } = await scaffold.ctx.sessionController.rename({
      sessionId: SessionId(SEED_ID), title: `Unarchive target ${SEED_ID}`,
    })
    const sessionRow = page.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) })
    await expect.poll(() => sessionRow.count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => sessionRow.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')

    const refused: string[] = []
    const refuse = async (method: string, code: string) => {
      await page.route(`**/api/${method}`, async (route) => {
        const envelope = route.request().postDataJSON() as { rpcId: string }
        await route.fulfill({ json: {
          type: 'server-response', rpcId: envelope.rpcId,
          result: { ok: false, error: { code, message: 'Injected failure', details: {} } },
        } })
      }, { times: 1 })
    }
    await refuse('session/fork', 'session/fork-unavailable')
    await clickHoverAction(sessionRow, `Session actions for ${title}`)
    await page.getByRole('menuitem', { name: 'Fork session' }).click()
    const forkRefusal = page.getByRole('alert').filter({ hasText: 'This session has no completed turn' })
    await forkRefusal.waitFor()
    refused.push(await forkRefusal.ariaSnapshot())

    await refuse('workspace/archiveSession', 'gateway/internal')
    await clickHoverAction(sessionRow, `Session actions for ${title}`)
    await page.getByRole('menuitem', { name: 'Archive session' }).click()
    const archiveRefusal = page.getByRole('alert').filter({ hasText: 'Archive failed. Try again later.' })
    await archiveRefusal.waitFor()
    refused.push(await archiveRefusal.ariaSnapshot())
    expect([...scaffold.ctx.workspaceRegistry.archivedSessionIds]).toEqual([])

    // Archive from the row menu: no confirmation dialog, and losing the last
    // visible Session withdraws the whole Ungrouped bucket.
    await clickHoverAction(sessionRow, `Session actions for ${title}`)
    await page.getByRole('menuitem', { name: 'Archive session' }).click()
    await expect.poll(() => sessionRow.count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => page.getByText('Ungrouped', { exact: true }).count(), { timeout: 10_000 }).toBe(0)
    // Durable on the host: the registry-global set carries the id while the
    // Session log itself stays in persistence untouched.
    expect([...scaffold.ctx.workspaceRegistry.archivedSessionIds]).toEqual([SessionId(SEED_ID)])
    expect((await scaffold.ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id))
      .toContain(SessionId(SEED_ID))

    await page.getByRole('button', { name: 'View options' }).click()
    await page.getByRole('menuitem', { name: 'All conversations (show archived)', exact: true }).click()
    await ungroupedSection()
    await expect.poll(() => sessionRow.count(), { timeout: 10_000 }).toBe(1)
    await refuse('workspace/unarchiveSession', 'gateway/internal')
    await clickHoverAction(sessionRow, `Session actions for ${title}`)
    await page.getByRole('menuitem', { name: 'Unarchive session' }).click()
    const restoreRefusal = page.getByRole('alert').filter({ hasText: 'Unarchive failed. Try again later.' })
    await restoreRefusal.waitFor()
    refused.push(await restoreRefusal.ariaSnapshot())
    expect([...scaffold.ctx.workspaceRegistry.archivedSessionIds]).toEqual([SessionId(SEED_ID)])
    await compareOrRefreshGolden(REFUSED_EXPECTED, refused.join('\n'), webSnapshotMode())
    await clickHoverAction(sessionRow, `Session actions for ${title}`)
    await page.getByRole('menuitem', { name: 'Unarchive session' }).click()
    await expect.poll(
      () => [...scaffold.ctx.workspaceRegistry.archivedSessionIds],
      { timeout: 10_000 },
    ).toEqual([])
    // Back to the default filter: the restored row must be an ordinary row
    // again, visible without any archived rows in the view.
    await page.getByRole('button', { name: 'View options' }).click()
    await page.getByRole('menuitem', { name: 'Hide archived', exact: true }).click()
    await ungroupedSection()
    await expect.poll(() => sessionRow.count(), { timeout: 15_000 }).toBe(1)

    // Reload: the restored row is rebuilt from the host baseline, so the
    // unarchive was durable and not merely client state.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await ungroupedSection()
    await expect.poll(() => sessionRow.count(), { timeout: 15_000 }).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it('saves a failed send while Plugins is open and restores both drafts after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-failed-draft-panel'))
    const selectedRow = (await ungroupedSection()).locator('[role="treeitem"]')
      .filter({ has: page.locator('button[aria-label^="Session actions for "]') })
    await selectedRow.click()
    const input = page.locator('[data-composer-input]').first()
    await expect.poll(() => input.getAttribute('contenteditable')).toBe('true')
    const received = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    await page.route('**/api/session/prompt', async (route) => {
      received.resolve(undefined)
      await release.promise
      const envelope = route.request().postDataJSON() as { rpcId: string }
      await route.fulfill({ json: {
        type: 'server-response', rpcId: envelope.rpcId,
        result: { ok: false, error: { code: 'session/agent-busy', message: 'Injected failure', details: {} } },
      } })
    }, { times: 1 })
    try {
      await input.fill('Failed send')
      await input.press('Enter')
      await received.promise
      await input.fill('Newer draft')
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      await input.waitFor({ state: 'hidden' })
    } finally { release.resolve(undefined) }
    await expect.poll(() => page.evaluate((id) => {
      const stored = JSON.parse(localStorage.getItem(`dsh.conversation.${id}`) ?? '{}') as { draft?: { text?: string } }
      return stored.draft?.text
    }, SEED_ID)).toBe('Failed send\n\nNewer draft')

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    const row = (await ungroupedSection()).locator('[role="treeitem"]')
      .filter({ has: page.locator('button[aria-label^="Session actions for "]') })
    await row.click()
    await input.waitFor()
    await expect.poll(() => input.locator('p').allTextContents()).toEqual(['Failed send', '', 'Newer draft'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})
