/**
 * The process-facing effects every `dsh agents` verb writes through, and the
 * shared human-text/`--json` output switch.
 * @module @deepseek-ai/dsh-agents/io
 */

import type { AgentsEvent } from './render.ts'

/** Process-facing effects of one verb: output streams plus the launcher's bounded exit request. */
export interface AgentsIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/**
 * Write one line of output on stdout: the serialized event in `--json` mode,
 * the human text otherwise.
 * @param io - process-facing effects.
 * @param json - whether this invocation asked for the machine-readable stream.
 * @param event - the event `--json` mode serializes.
 * @param line - the human-readable text default mode prints.
 */
export function writeLine(io: AgentsIo, json: boolean, event: AgentsEvent, line: string): void {
  io.stdout.write(json ? `${JSON.stringify(event)}\n` : `${line}\n`)
}
