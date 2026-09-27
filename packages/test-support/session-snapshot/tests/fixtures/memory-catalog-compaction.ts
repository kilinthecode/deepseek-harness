import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { appendFixtureCompaction } from './fixture-compaction.ts'

export const name = 'memory-catalog-compaction'

/** Compact the surfaced memory catalog away after a `memory_recall` call whose query is `shell`. */
export function apply(ctx: Context): void {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (result.isError
      || exec.agent === undefined
      || exec.name !== 'memory_recall'
      || typeof exec.arguments !== 'object'
      || exec.arguments === null
      || !('query' in exec.arguments)
      || exec.arguments.query !== 'shell') return downstream
    const agent = exec.agent
    const catalog = agent.session.surface.nodes
      .map(seq => agent.session.snapshotEvents()[seq])
      .findLast(event => event?.type === 'user/message'
        && event.data.source.kind === 'tool-memory')
    if (catalog === undefined) throw new Error('memory catalog missing before snapshot compaction')
    appendFixtureCompaction(agent, catalog, 'memory-catalog-fixture')
    return downstream
  })
}
