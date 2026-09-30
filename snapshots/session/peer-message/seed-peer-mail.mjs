/**
 * Seed the peer mailbox of every agent this process creates.
 *
 * `agent/created` is serial, and this listener prepends, so both envelopes are
 * durable before the peer service's own listener drains the fresh session. Both
 * ids and the sender are fixed literals so the recorded fixture is stable.
 */

import { enqueueMail, PEER_MAIL_VERSION, peerRepoKey } from '@deepseek-ai/dsh-experimental-peer-sessions'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'

/** Envelope ids, which are also the message ids the delivery source carries. */
const MESSAGE_ID = 'peer-msg-1'
const IDLE_ID = 'peer-idle-1'
/** Sender identity stamped on both envelopes. */
const SENDER_SESSION_ID = 'session-peer-sender'
const SENDER_NAME = 'session-peer-sender'
/** Shipped mailbox caps, restated because a foreign writer supplies them. */
const LIMITS = { maxPendingPerTarget: 8, maxPendingPerSenderPerTarget: 4 }

/** Cordis plugin name. */
export const name = 'peer-seed-mail'
/** The service whose mailbox this plugin fills. */
export const inject = ['peers']

/**
 * Write both envelopes for one created agent.
 * @param ctx - the process context.
 */
export function apply(ctx) {
  ctx.on('agent/created', async ({ agent }) => {
    const repoKey = await peerRepoKey(await realpathNormalize(agent.session.header.cwd))
    const shared = {
      version: PEER_MAIL_VERSION,
      targetId: agent.id,
      senderSessionId: SENDER_SESSION_ID,
      senderName: SENDER_NAME,
      fromRepo: repoKey,
      relayDepth: 1,
    }
    await enqueueMail(resolveDshHome(), {
      ...shared,
      messageId: MESSAGE_ID,
      kind: 'peer-message',
      text: 'Heads-up: I am about to fast-forward the shared master ref. Please do not move master for the next few minutes. No reply is needed.',
    }, LIMITS, agent.id)
    await enqueueMail(resolveDshHome(), {
      ...shared,
      messageId: IDLE_ID,
      kind: 'peer-idle',
      // The service frames the notice itself; an idle envelope carries no sender text.
      text: '',
    }, LIMITS, agent.id)
  }, { prepend: true })
}
