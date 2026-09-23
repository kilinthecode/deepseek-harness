/**
 * Team-owned image admission: strip a sender's or a replayed copy's offload
 * mark before content enters a durable mailbox or spawn prompt, and refuse a
 * target whose resolved route cannot accept the image before any durable
 * append. Not part of the package's public surface — the mailbox and roster
 * are its only callers.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import { assertContinuableChildAcceptsImages, assertImageCapableRoute } from '@deepseek-ai/dsh-subagent/internal'
import { TeamError } from './error.ts'

/**
 * Clone Team-bound content and remove `offloaded` from every image block.
 * Offload is a per-target compaction decision the receiver makes about its
 * own request history; a sender's mark, or one carried by a replayed copy,
 * must not travel with content admitted into a different Session's log.
 * @param content - content about to enter a Team mailbox message or spawn prompt.
 * @returns a detached clone with every image block's `offloaded` mark removed.
 */
export function admitTeamContent(content: readonly ContentBlock[]): ContentBlock[] {
  return structuredClone(content).map((block) => {
    if (block.type !== 'image' || block.offloaded !== true) return block
    const { offloaded: _offloaded, ...rest } = block
    return rest
  })
}

/**
 * Remap a subagent-owned image-capability refusal, identified by its code
 * rather than `SubagentError` class identity (this module and the bundled
 * runtime entry can resolve that class to different identities), to a
 * Team-owned refusal. Rethrows every other failure unchanged.
 * @param error - the failure caught from the subagent-owned gate.
 * @throws {TeamError} `TEAM_IMAGES_UNSUPPORTED` when `error` is the subagent image-capability refusal.
 */
function remapImageRefusal(error: unknown): never {
  if (error instanceof HarnessError && error.code === 'MODEL_DOES_NOT_SUPPORT_IMAGES') {
    throw new TeamError(error.message, 'TEAM_IMAGES_UNSUPPORTED')
  }
  throw error
}

/**
 * Refuse image content for one resolved provider/model route, remapped to a
 * Team-owned refusal. Delegates to the subagent-owned image-capability gate
 * so the permissive policy and refusal text stay one definition across every
 * delegation route; only the thrown error's identity changes here.
 * @param ctx - Team service context providing the optional `llm` service.
 * @param provider - resolved route provider name, or undefined when unresolved.
 * @param model - resolved route model name, or undefined when unresolved.
 * @param signal - caller cancellation for the model-info resolution.
 * @throws {TeamError} `TEAM_IMAGES_UNSUPPORTED` when the route's declared modalities omit image.
 */
export async function assertTeamRouteAcceptsImages(
  ctx: Context,
  provider: string | undefined,
  model: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  try {
    await assertImageCapableRoute(ctx, provider, model, signal)
  } catch (error: unknown) {
    remapImageRefusal(error)
  }
}

/**
 * Refuse image content for one Team target before any durable side effect.
 * The Lead target's route is the live root Agent's current delegation route
 * (its latest logged request, not its creation-time options); a teammate's
 * route comes from `dsh-subagent`'s continuable-child probe (live Activation,
 * else the persisted descriptor, else the Lead's current delegation route).
 * @param ctx - Team service context providing the optional `llm` and `subagents` services.
 * @param root - exact live Team Lead.
 * @param targetId - durable Lead or teammate session id.
 * @param signal - caller cancellation for the route resolution.
 * @throws {TeamError} `TEAM_IMAGES_UNSUPPORTED` when the target's resolved route refuses images.
 */
export async function assertTeamTargetAcceptsImages(
  ctx: Context,
  root: Agent,
  targetId: SessionId,
  signal: AbortSignal,
): Promise<void> {
  if (targetId === root.id) {
    const route = parentAgentOptionsForDelegation(root)
    await assertTeamRouteAcceptsImages(ctx, route.provider, route.model, signal)
    return
  }
  try {
    await assertContinuableChildAcceptsImages(ctx.subagents, root, targetId, signal)
  } catch (error: unknown) {
    remapImageRefusal(error)
  }
}
