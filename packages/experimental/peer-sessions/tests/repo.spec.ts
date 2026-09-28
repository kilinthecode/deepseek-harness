import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import { peerRepoKey } from '../src/index.ts'
import { mountPeerHarness, type PeerHarness } from './harness.ts'

const roots: string[] = []
const harnesses: PeerHarness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** One hand-written git layout: a main checkout, a linked worktree, and the fallback directories. */
interface Fixture {
  /** Main checkout, with a real `.git` directory. */
  readonly main: string
  /** The main checkout's `.git` directory. */
  readonly mainGit: string
  /** A subdirectory of the main checkout used to exercise the walk up. */
  readonly mainNested: string
  /** A directory inside the main checkout holding a malformed `.git` file. */
  readonly mainBroken: string
  /** Linked worktree of `main`, holding a `.git` file instead of a directory. */
  readonly worktree: string
  /** A subdirectory of the linked worktree. */
  readonly worktreeNested: string
  /** Submodule-style checkout whose gitfile has no `commondir`. */
  readonly submodule: string
  /** The administrative directory that submodule gitfile points at. */
  readonly submoduleGit: string
  /** Directory whose `.git` file is not a gitfile at all. */
  readonly malformed: string
  /** Directory with no `.git` anywhere above it. */
  readonly plain: string
  /** Gitfile whose `gitdir` line names a directory that does not exist. */
  readonly dangling: string
  /** Directory whose `.git` entry is a symlink rather than a marker. */
  readonly symlinkedMarker: string
  /** Directory symlink to `root`, resolved by the caller before the walk. */
  readonly link: string
}

/**
 * Lay out one repository on disk the way git writes it, without running git.
 * @returns the fixture directories, each already canonical.
 */
async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-peer-repo-')))
  roots.push(root)
  const main = join(root, 'main')
  const mainGit = join(main, '.git')
  const worktreeGitdir = join(mainGit, 'worktrees', 'wt')
  const mainNested = join(main, 'deep', 'dir')
  const mainBroken = join(main, 'broken')
  const worktree = join(root, 'worktree')
  const worktreeNested = join(worktree, 'src', 'nested')
  const submodule = join(root, 'submodule')
  const submoduleGit = join(root, 'modules', 'sub')
  const malformed = join(root, 'malformed')
  const plain = join(root, 'plain')
  const link = join(root, 'link')
  await mkdir(worktreeGitdir, { recursive: true })
  await mkdir(mainNested, { recursive: true })
  await mkdir(mainBroken, { recursive: true })
  await mkdir(worktreeNested, { recursive: true })
  await mkdir(submodule, { recursive: true })
  await mkdir(submoduleGit, { recursive: true })
  await mkdir(malformed, { recursive: true })
  await mkdir(plain, { recursive: true })
  const dangling = join(root, 'dangling')
  const symlinkedMarker = join(root, 'symlinked-marker')
  await mkdir(dangling, { recursive: true })
  await mkdir(symlinkedMarker, { recursive: true })
  // A linked worktree's `.git` file names its own administrative directory; that
  // directory's `commondir` names the repository both checkouts share.
  await writeFile(join(worktree, '.git'), `gitdir: ${worktreeGitdir}\n`)
  await writeFile(join(worktreeGitdir, 'commondir'), '../..\n')
  // A submodule checkout has a gitfile and no commondir: its gitdir is a
  // repository of its own. This one is written without a trailing newline.
  await writeFile(join(submodule, '.git'), 'gitdir: ../modules/sub')
  await writeFile(join(malformed, '.git'), 'this file names no gitdir\n')
  await writeFile(join(mainBroken, '.git'), 'gitdir:\n')
  // A gitfile may name a gitdir that is gone, and a `.git` entry may be a
  // symlink, which is neither the directory nor the regular file a marker must be.
  await writeFile(join(dangling, '.git'), 'gitdir: ./missing-admin\n')
  await symlink(mainGit, join(symlinkedMarker, '.git'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir')
  return {
    main, mainGit, mainNested, mainBroken, worktree, worktreeNested,
    submodule, submoduleGit, malformed, plain, dangling, symlinkedMarker, link,
  }
}

describe('peerRepoKey', () => {
  it('keys a main checkout by its canonical .git directory', async () => {
    const f = await fixture()
    expect(await peerRepoKey(f.main)).toBe(`git:${await realpath(f.mainGit)}`)
  })

  it('walks up from a subdirectory to the enclosing checkout', async () => {
    const f = await fixture()
    expect(await peerRepoKey(f.mainNested)).toBe(`git:${await realpath(f.mainGit)}`)
  })

  it('keys a linked worktree the same as its main checkout', async () => {
    const f = await fixture()
    expect(await peerRepoKey(f.worktree)).toBe(`git:${await realpath(f.mainGit)}`)
  })

  it('walks up from a subdirectory of a linked worktree to the shared repository', async () => {
    const f = await fixture()
    expect(await peerRepoKey(f.worktreeNested)).toBe(`git:${await realpath(f.mainGit)}`)
  })

  it('keys a submodule-style gitfile without a commondir as its own repository', async () => {
    const f = await fixture()
    const key = await peerRepoKey(f.submodule)
    expect(key).toBe(`git:${await realpath(f.submoduleGit)}`)
    expect(key).not.toBe(`git:${await realpath(f.mainGit)}`)
  })

  it('stops the walk at a malformed .git file and falls back to the directory key', async () => {
    const f = await fixture()
    expect(await peerRepoKey(f.malformed)).toBe(`dir:${f.malformed}`)
  })

  it('does not inherit an enclosing repository from a directory whose own .git file is unusable', async () => {
    const f = await fixture()
    expect(await peerRepoKey(f.mainBroken)).toBe(`dir:${f.mainBroken}`)
  })

  it('falls back to the directory key when no .git exists up to the root', async () => {
    const f = await fixture()
    expect(await peerRepoKey(f.plain)).toBe(`dir:${f.plain}`)
  })

  it('keys a symlinked working directory the same as its canonical target', async () => {
    const f = await fixture()
    const canonical = await realpathNormalize(join(f.link, 'worktree'))
    expect(canonical).toBe(f.worktree)
    expect(await peerRepoKey(canonical)).toBe(`git:${await realpath(f.mainGit)}`)
    // The walk canonicalizes the marker it finds, so an unresolved symlinked
    // prefix still yields the shared key.
    expect(await peerRepoKey(join(f.link, 'worktree'))).toBe(`git:${await realpath(f.mainGit)}`)
    expect(await peerRepoKey(join(f.link, 'main'))).toBe(`git:${await realpath(f.mainGit)}`)
  })

  it('ignores GIT_DIR in the environment', async () => {
    const f = await fixture()
    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = f.mainGit
    try {
      expect(await peerRepoKey(f.plain)).toBe(`dir:${f.plain}`)
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previous
    }
  })

  it('falls back to the directory key when the gitfile names a missing gitdir', async () => {
    const f = await fixture()
    expect(await peerRepoKey(f.dangling)).toBe(`dir:${f.dangling}`)
  })

  it('falls back to the directory key when the .git entry is a symlink', async () => {
    const f = await fixture()
    expect(await peerRepoKey(f.symlinkedMarker)).toBe(`dir:${f.symlinkedMarker}`)
  })

  // An unreadable file needs a filesystem that enforces permissions; root reads
  // through mode 0o000, so the unreadable-marker cases are pinned on POSIX non-root.
  it.runIf(
    process.getuid !== undefined && process.getuid() !== 0,
  )('falls back to the directory key when the .git file cannot be read', async () => {
    const f = await fixture()
    const sealed = join(f.main, 'sealed')
    await mkdir(sealed, { recursive: true })
    await writeFile(join(sealed, '.git'), 'gitdir: ./admin\n')
    await chmod(join(sealed, '.git'), 0o000)
    expect(await peerRepoKey(sealed)).toBe(`dir:${sealed}`)
  })

  it.runIf(
    process.getuid !== undefined && process.getuid() !== 0,
  )('falls back to the directory key when a commondir exists but cannot be read', async () => {
    const f = await fixture()
    const gitdir = join(f.main, '.git', 'worktrees', 'sealed')
    const sealed = join(f.main, 'sealed-worktree')
    await mkdir(gitdir, { recursive: true })
    await mkdir(sealed, { recursive: true })
    await writeFile(join(gitdir, 'commondir'), '../..\n')
    await chmod(join(gitdir, 'commondir'), 0o000)
    await writeFile(join(sealed, '.git'), `gitdir: ${gitdir}\n`)
    expect(await peerRepoKey(sealed)).toBe(`dir:${sealed}`)
  })
})

describe('peers grouped by repository', () => {
  it('lists and delivers across two worktrees of one checkout', async () => {
    const harness = await mountPeerHarness({ peer: { pollMs: 60_000 } })
    harnesses.push(harness)
    // The harness workdir becomes a checkout, and each session starts in its
    // own worktree directory of it.
    await mkdir(join(harness.workdir, '.git'), { recursive: true })
    const firstWorktree = join(harness.workdir, 'checkout-a')
    const secondWorktree = join(harness.workdir, 'checkout-b')
    await mkdir(firstWorktree, { recursive: true })
    await mkdir(secondWorktree, { recursive: true })
    const sender = await harness.create('peer-a', { cwd: firstWorktree })
    const target = await harness.create('peer-b', { cwd: secondWorktree })
    expect(await harness.ctx.peers.list(sender)).toEqual([{
      kind: 'session',
      id: 'peer-b',
      name: 'peer-b',
      status: 'idle',
      cwd: secondWorktree,
      provider: 'mock',
      model: 'mock',
    }])
    expect((await harness.ctx.peers.send(sender, { to: 'peer-b', message: 'shared ref' })).status)
      .toBe('delivered')
    await target.whenIdle()
    expect(harness.userMessages(target).map(message => message.source.kind)).toEqual(['peer-message'])
  })
})
