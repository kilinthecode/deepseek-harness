/** Agent Teams navigation and shared drafts over recorded Conversation history. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession,
  watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/agent-teams-navigation', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./agent-team-panel.overlay.yml', import.meta.url))
const INSTALL_ANCHOR = fileURLToPath(new URL('../../../packages/experimental/agent-team-profile/package.json', import.meta.url))

it('opens Agent Teams from the sidebar, preserves drafts, and keeps the glass composer dark', async () => {
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: [INSTALL_ANCHOR] })
  onTestFinished(() => scaffold.close())
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  await workspace.setTitle('Team workspace')
  const id = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'teams-navigation')
  await workspace.attachSession(id)
  await scaffold.ctx.sessionController.rename({ sessionId: id, title: 'Recorded conversation' })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  try {
    await page.addInitScript(({ workspaceId, sessionId }) => {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
      localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({
        groupBy: 'workspace', orderBy: 'updated', groupExpansion: { [workspaceId]: true },
      }))
    }, { workspaceId: workspace.id, sessionId: id })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const teams = page.getByRole('button', { name: 'Agent Teams', exact: true })
    await page.getByText('DONE', { exact: true }).waitFor()
    expect(await page.locator('[data-team-action]').count()).toBe(0)
    await teams.click()
    const teamPage = page.locator('[data-agent-teams-page]')
    await teamPage.waitFor()
    await page.getByText('DONE', { exact: true }).waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'page.expected.md'),
      await captureStableAria(page, '[data-agent-teams-page]', scaffold.workspaceCwd), webSnapshotMode())
    await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
    await page.locator('[data-content-phase="hero"]').waitFor()
    await teams.click()
    // The first workspace pick must retain the page that owns this composer.
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Team workspace', exact: true }).click()
    await expect.poll(() => teamPage.locator('[data-composer-input]').isEditable()).toBe(true)
    const composer = teamPage.locator('[data-composer-input]')
    await composer.fill('Draft for the team')
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    await teams.click()
    expect(await composer.textContent()).toBe('Draft for the team')
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await expect.poll(() => teams.textContent()).toBe('')
    await expect.poll(() => teams.locator('svg').count()).toBe(1)
    expect(await teams.getAttribute('aria-current')).toBe('page')
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
    await expect.poll(() => teams.textContent()).toBe('Agent Teams')
    const originalDark = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
    try {
      for (const dark of [false, true]) {
        await page.evaluate((dark) => { document.body.toggleAttribute('data-ds-dark-theme', dark) }, dark)
        const appearance = await teamPage.locator('[data-composer-card]').evaluate((element) => {
          const material = getComputedStyle(element, '::before')
          const style = getComputedStyle(element)
          return {
            image: material.backgroundImage, filter: material.backdropFilter,
            color: style.color, filterOnCard: style.backdropFilter,
          }
        })
        expect(appearance.image).toContain('linear-gradient')
        expect(appearance.filter).toContain('blur(')
        expect(appearance.filterOnCard).toBe('none')
        expect(appearance.color).toBe('rgb(250, 250, 250)')
        const send = await teamPage.getByRole('button', { name: 'Send message', exact: true }).evaluate((element) => {
          const style = getComputedStyle(element)
          return { background: style.backgroundColor, color: style.color }
        })
        expect(send).toEqual({ background: 'rgb(250, 250, 250)', color: 'rgb(15, 15, 15)' })
      }
    } finally {
      await page.evaluate((dark) => { document.body.toggleAttribute('data-ds-dark-theme', dark) }, originalDark)
    }
    expect(console.pageErrors).toEqual([])
  } catch (error) {
    await saveFailureShot(page, 'web-e2e-agent-teams-navigation')
    throw error
  }
})
