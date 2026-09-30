/**
 * Publish one fake peer's activity row before the session under test takes a step.
 *
 * `agent/created` is serial and this listener prepends, so the row is durable
 * before the agent's first `agent/pre-step` reads the activity directory. The
 * row is written the way a peer in another process writes it: one JSON file
 * under `$DSH_HOME/peers/activity/`, named by the SHA-256 of the peer's session
 * id. Every value is a fixed literal except the repository key and checkout
 * root, which come from the walk the service uses so that the peer shares this
 * session's checkout, and the timestamps, which keep the row and its file fresh.
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { peerCheckout } from '@deepseek-ai/dsh-experimental-peer-sessions'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'

/** Session id of the fake peer; the row's file name is its hash. */
const PEER_SESSION_ID = 'session-peer-writer'
/** Row version the reader accepts (`PEER_ACTIVITY_VERSION`); a foreign writer restates it. */
const ACTIVITY_VERSION = 1
/**
 * Process id the row claims. The reader keeps a row unless `process.kill(pid, 0)`
 * fails with `ESRCH` (`peerProcessExited` in the peer service's `src/presence.ts`).
 * Pid 1 always exists: an unprivileged caller gets `EPERM`, which the reader
 * treats as alive, and root gets success. Checked as uid 501 on macOS with
 * Node 24: `process.kill(1, 0)` throws `EPERM`, and `process.kill(999999, 0)`
 * throws `ESRCH`. Windows has no such pid, so the manifest declares `posix`.
 */
const PEER_PID = 1

/** Cordis plugin name. */
export const name = 'peer-seed-activity'
/** The service whose activity directory this plugin fills. */
export const inject = ['peers']

/**
 * Write the fake peer's row for one created agent.
 * @param ctx - the process context.
 */
export function apply(ctx) {
  ctx.on('agent/created', async ({ agent }) => {
    const checkout = await peerCheckout(await realpathNormalize(agent.session.header.cwd))
    const now = Date.now()
    const directory = join(resolveDshHome(), 'peers', 'activity')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(
      join(directory, `${createHash('sha256').update(PEER_SESSION_ID).digest('hex')}.json`),
      `${JSON.stringify({
        version: ACTIVITY_VERSION,
        sessionId: PEER_SESSION_ID,
        repoKey: checkout.key,
        // The session's own checkout root, so the block reports `"checkout":"shared"`.
        root: checkout.root,
        cwd: checkout.root,
        name: 'Fix login race',
        status: 'running',
        pid: PEER_PID,
        updatedAt: now,
        doing: 'Rewrite the session refresh',
        files: [{ p: 'rel:src/a.ts', at: now }],
      })}\n`,
      { mode: 0o600 },
    )
  }, { prepend: true })
}
