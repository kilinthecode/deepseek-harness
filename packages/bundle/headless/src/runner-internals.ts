/**
 * Process streams the runner reads and writes, kept out of the package entry so
 * substituting them in tests adds no public package API. The shape matches the
 * runner's own IO carrier structurally.
 * @module @deepseek-ai/dsh-headless/runner-internals
 */

import { processRunnerStreams } from '@deepseek-ai/dsh-cmdline'
import type { RunnerStreams } from '@deepseek-ai/dsh-cmdline'

/** The process streams the runner reads and writes; tests substitute captures on this package's own instance. */
export const internals: RunnerStreams = processRunnerStreams()
