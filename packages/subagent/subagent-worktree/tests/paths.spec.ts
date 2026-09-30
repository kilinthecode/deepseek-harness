import { describe, expect, it } from 'vitest'
import {
  layoutFor, recordPathFor, repoKeyFor, reviewCheckoutPathFor, reviewCheckoutPrefixFor, worktreeDirFor,
} from '../src/paths.ts'

describe('repoKeyFor', () => {
  it('combines a sanitized basename with a stable content hash', () => {
    const key = repoKeyFor('/home/user/my-repo')
    expect(key).toMatch(/^my-repo-[0-9a-f]{12}$/)
  })

  it('names an ordinary repository after the directory that holds its .git, not after .git itself', () => {
    expect(repoKeyFor('/home/user/my-repo/.git')).toMatch(/^my-repo-[0-9a-f]{12}$/)
    expect(repoKeyFor('/home/user/other-repo/.git')).toMatch(/^other-repo-[0-9a-f]{12}$/)
  })

  it('names a bare repository after its own directory', () => {
    expect(repoKeyFor('/srv/git/project.git')).toMatch(/^project\.git-[0-9a-f]{12}$/)
  })

  it('keys the common directory apart from the checkout directory that holds it', () => {
    expect(repoKeyFor('/home/user/my-repo/.git')).toBe(repoKeyFor('/home/user/my-repo/.git'))
    expect(repoKeyFor('/home/user/my-repo/.git')).not.toBe(repoKeyFor('/home/user/my-repo'))
  })

  it('is deterministic for the same path and distinct for different paths', () => {
    expect(repoKeyFor('/a/repo')).toBe(repoKeyFor('/a/repo'))
    expect(repoKeyFor('/a/repo')).not.toBe(repoKeyFor('/b/repo'))
  })

  it('sanitizes characters unsafe for a path segment, collapsing a run to one hyphen', () => {
    const key = repoKeyFor('/tmp/my repo (copy)')
    expect(key.startsWith('my-repo-copy-')).toBe(true)
  })

  it('falls back to a fixed name when the basename is already empty (a root path)', () => {
    // path.basename('/') is '' — sanitizing collapses a run of unsafe characters
    // to one hyphen, so only a genuinely empty basename reaches the fallback.
    const key = repoKeyFor('/')
    expect(key.startsWith('repo-')).toBe(true)
  })

  it('distinguishes two repositories that share a sanitized basename', () => {
    const first = repoKeyFor('/work/checkout-a/repo')
    const second = repoKeyFor('/work/checkout-b/repo')
    expect(first).not.toBe(second)
    expect(first.startsWith('repo-')).toBe(true)
    expect(second.startsWith('repo-')).toBe(true)
  })
})

describe('directory layout', () => {
  it('derives records, reviews, and merge-lock paths under the repository directory', () => {
    const layout = layoutFor('/root', 'repo-abc123456789')
    expect(layout.repoDir).toBe('/root/repo-abc123456789')
    expect(layout.recordsDir).toBe('/root/repo-abc123456789/records')
    expect(layout.reviewsDir).toBe('/root/repo-abc123456789/reviews')
    expect(layout.mergeLockPath).toBe('/root/repo-abc123456789/merge')
  })

  it('derives the worktree, record, and review checkout paths for one id', () => {
    const layout = layoutFor('/root', 'repo-key')
    expect(worktreeDirFor(layout, 'wt-aabbccdd')).toBe('/root/repo-key/wt-aabbccdd')
    expect(recordPathFor(layout, 'wt-aabbccdd')).toBe('/root/repo-key/records/wt-aabbccdd.json')
    expect(reviewCheckoutPathFor(layout, 'wt-aabbccdd', 42)).toBe('/root/repo-key/reviews/wt-aabbccdd-42')
    expect(reviewCheckoutPrefixFor('wt-aabbccdd')).toBe('wt-aabbccdd-')
  })
})

describe('paths built from a worktree id', () => {
  const layout = layoutFor('/root', 'repo-key')
  const badIds = ['../x', 'wt-../../x', 'wt-AABBCCDD', 'wt-aabbccd', 'wt-aabbccdde', '', 'wt-aabbccdd/..', 'x/wt-aabbccdd']

  it.each(badIds)('worktreeDirFor refuses %j before joining it into a path', (id) => {
    expect(() => worktreeDirFor(layout, id)).toThrow('is not a worktree id')
  })

  it.each(badIds)('recordPathFor refuses %j before joining it into a path', (id) => {
    expect(() => recordPathFor(layout, id)).toThrow('is not a worktree id')
  })

  it.each(badIds)('reviewCheckoutPathFor refuses %j before joining it into a path', (id) => {
    expect(() => reviewCheckoutPathFor(layout, id, 1)).toThrow('is not a worktree id')
  })

  it.each(badIds)('reviewCheckoutPrefixFor refuses %j', (id) => {
    expect(() => reviewCheckoutPrefixFor(id)).toThrow('is not a worktree id')
  })
})
