#!/usr/bin/env node
/**
 * Command-line entry for the `portal` command: the same launcher, named for
 * the Portal terminal agent profile it boots by default.
 * @module @deepseek-ai/dsh/bin-portal
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { runCli } from './cli.ts'

if (import.meta.main) {
  await runCli('portal')
}
