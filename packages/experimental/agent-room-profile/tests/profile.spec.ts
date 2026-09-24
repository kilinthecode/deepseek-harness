/** The experimental room bundle must carry one parseable, explicit room layer. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface InsertedRow {
  id?: string
  name?: string
  config?: Record<string, unknown>
}

describe('Agent room profile bundle', () => {
  it('declares a public parseable layer that enables rooms without changing the shipped profiles', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      private?: boolean
      publishConfig?: { access?: string }
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-experimental-agent-team': 'workspace:*',
      '@deepseek-ai/dsh-experimental-client-ui-agent-team': 'workspace:*',
      '@deepseek-ai/dsh-experimental-tool-agent-room': 'workspace:*',
      '@deepseek-ai/dsh-experimental-tool-agent-team': 'workspace:*',
    })

    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    const patches = parsed as { insert?: InsertedRow[] }[]
    const inserted = patches.flatMap(patch => patch.insert ?? [])
    expect(inserted.find(row => row.id === 'agent-team')?.config).toEqual({
      maxMembers: 8,
      maxTasks: 256,
      maxPendingMessagesPerMember: 64,
      maxMessageBytes: 65536,
      disposalTimeoutMs: 5000,
      roomEnabled: true,
      roomTranscriptWindow: 20,
      roomApprovalRatio: 0.5,
      roomMaxProposalRevisions: 4,
      roomReviewGraceMs: 120000,
      roomReviewReminders: 1,
    })
    // A room needs participants, so the layer keeps the Team delegation tools.
    expect(inserted.find(row => row.id === 'tool-agent-team')?.name)
      .toBe('@deepseek-ai/dsh-experimental-tool-agent-team')
    expect(inserted.find(row => row.id === 'tool-agent-room')?.name)
      .toBe('@deepseek-ai/dsh-experimental-tool-agent-room')
    // The browser UI rides in the same layer, as in the Agent Teams bundle.
    expect(inserted.find(row => row.id === 'ui-agent-team')?.name)
      .toBe('@deepseek-ai/dsh-experimental-client-ui-agent-team')
    // Rooms are opt-in: the layer inserts rows and disables nothing.
    expect(patches.every(patch => Object.keys(patch).every(key => key === 'insert'))).toBe(true)
  })
})
