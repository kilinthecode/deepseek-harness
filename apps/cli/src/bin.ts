#!/usr/bin/env node
/**
 * Command-line entry for dsh.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { runCli } from './cli.ts'

/** The shared command-line dispatch; the Python SDK runtime bootstrap starts it from this module. */
export { runCli }

if (import.meta.main) {
  await runCli('dsh')
}
