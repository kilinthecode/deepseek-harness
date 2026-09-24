import type { Agent } from '@deepseek-ai/dsh-agent'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Append one deterministic compaction to the agent's open turn: the summary
 * shadows `shadowed` and its checkpoint message replaces that surface node.
 * @param agent - the agent whose session is compacted.
 * @param shadowed - the surface event the checkpoint replaces.
 * @param id - the compaction id recorded on every compaction event.
 */
export function appendFixtureCompaction(agent: Agent, shadowed: SessionEvent, id: string): void {
  const openTurn = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')
  if (openTurn?.type !== 'turn/start') throw new Error(`snapshot compaction ${id} has no open turn`)
  const compactionId = CompactionId(id)
  const content = [{ type: 'text' as const, text: 'Earlier context was compacted for this snapshot.' }]
  agent.session.append('compaction/start', { compactionId, turn: openTurn.data.turn })
  agent.session.append('compaction/summary', {
    compactionId,
    summary: content,
    shadowedRange: { start: shadowed.seq, end: shadowed.seq },
    shadowedSeqs: [shadowed.seq],
    shadowedTokenCount: 1,
    provider: 'snapshot',
    model: 'snapshot',
  })
  agent.session.append('user/message', createUserMessage({
    content,
    source: compactCheckpointSource(compactionId),
  }), {
    surfaceOp: { op: 'replace', startSeq: shadowed.seq, endSeq: shadowed.seq },
    sourceEventSeqs: [shadowed.seq],
  })
  agent.session.append('compaction/end', { compactionId, turn: openTurn.data.turn })
}
