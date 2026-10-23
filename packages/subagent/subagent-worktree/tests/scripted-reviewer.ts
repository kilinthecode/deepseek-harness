/** Package-local scripted `spawn`-provider fixture standing in for a real reviewer child. */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SubagentCapabilities, SubagentProvider, SubagentResult, SubagentRun, SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'

const REVIEWER_CAPABILITIES: SubagentCapabilities = {
  agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true, cwd: true,
}

/** One scripted reviewer run's outcome. */
export interface ScriptedVerdict {
  /** The value returned as `SubagentResult.structured`; omit to script a missing/invalid structured result. */
  structured?: unknown
  /** Terminal stop reason; defaults to `completed`. */
  stopReason?: SubagentResult['stopReason']
  /** When set, `run.result` rejects with this message instead of resolving — an infrastructure fault, not a verdict. */
  throws?: string
  /** When set, `run.result` settles only after this promise resolves, keeping the review in flight for overlap tests. */
  holdUntil?: Promise<void>
}

/** Options for the scripted `spawn` provider fixture. */
export interface Config {
  /** Registry name to register under; the reviewer flow always requests `spawn`. */
  name?: string
  /** Verdicts returned in call order; a call past the end repeats the last entry. */
  verdicts: readonly ScriptedVerdict[]
  /** Observes each start request (the review checkout cwd, the diff-bearing prompt, the agent route). */
  onStart?: (request: SubagentStartRequest) => void
}

class ScriptedReviewerProvider implements SubagentProvider {
  readonly capabilities = REVIEWER_CAPABILITIES
  readonly inheritsParentContext = false
  private calls = 0

  constructor(readonly name: string, private readonly config: Config) {}

  start(request: SubagentStartRequest): Promise<SubagentRun> {
    this.config.onStart?.(request)
    const index = Math.min(this.calls, this.config.verdicts.length - 1)
    this.calls += 1
    const script = this.config.verdicts[index]
    const result: SubagentResult = {
      output: [{ type: 'text', text: 'reviewed' }],
      stopReason: script?.stopReason ?? 'completed',
      ...script !== undefined && 'structured' in script ? { structured: script.structured } : {},
    }
    const released = script?.holdUntil ?? Promise.resolve()
    const settled = released.then((): SubagentResult => {
      if (script?.throws !== undefined) throw new Error(script.throws)
      return result
    })
    return Promise.resolve({
      id: SessionId(`scripted-reviewer:${this.name}:${this.calls}`),
      localAgent: undefined,
      result: settled,
      dispose: () => Promise.resolve(),
    })
  }
}

/**
 * Mount one scripted `spawn` reviewer provider through an effect-scoped local plugin.
 * @param ctx - context carrying the real `subagents` registry.
 * @param config - scripted verdict sequence and start observer.
 * @returns the fixture plugin's disposable fiber.
 */
export function mountScriptedReviewer(ctx: Context, config: Config) {
  return ctx.plugin({
    name: 'scripted-worktree-reviewer',
    inject: ['subagents'],
    apply(pluginCtx: Context): void {
      pluginCtx.subagents.registerProvider(new ScriptedReviewerProvider(config.name ?? 'spawn', config))
    },
  })
}
