/**
 * The one subagent-owned image-capability gate: refuse a resolved child route
 * whose declared model cannot accept image input. Every delegation path that
 * resolves a provider/model before a durable or process side effect calls
 * this same check, so the policy and error never diverge across call sites.
 *
 * @module @deepseek-ai/dsh-subagent/image-capability
 */

import type { Context } from '@deepseek-ai/cordis'
import { imageInputSupport } from '@deepseek-ai/dsh-llm'
import { SubagentError } from './error.ts'

/**
 * Refuse image content for a resolved child route whose model declares
 * non-image input modalities. A missing provider or model, a missing `llm`
 * service, or a route whose modalities were never disclosed all proceed —
 * only a declared modality list that omits `image` refuses. This function is
 * also published through the `./internal` subpath, where the `SubagentError`
 * it constructs is a separate class from the bundled runtime entry's
 * (`lib/index.js`); match the refusal by `code`, not `instanceof SubagentError`.
 * @param ctx - context providing the optional `llm` service.
 * @param provider - resolved route provider name, or undefined when unresolved.
 * @param model - resolved route model name, or undefined when unresolved.
 * @param signal - caller cancellation for the model-info resolution.
 * @throws {SubagentError} `MODEL_DOES_NOT_SUPPORT_IMAGES` when the route's declared modalities omit image.
 */
export async function assertImageCapableRoute(
  ctx: Context,
  provider: string | undefined,
  model: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (provider === undefined || model === undefined) return
  const llm = ctx.get('llm')
  if (llm === undefined) return
  const info = await llm.resolveModelInfo(provider, model, signal)
  if (imageInputSupport(info) === 'unsupported') {
    throw new SubagentError(
      `Model "${model}" does not support image input.`,
      'MODEL_DOES_NOT_SUPPORT_IMAGES',
    )
  }
}
