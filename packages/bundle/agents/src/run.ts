/**
 * `dsh agents run`: create or reuse a worktree, run a worker in it, accept
 * the result, and retry with a fixer child for as many `--fix-rounds` as the
 * review or check command keeps failing.
 * @module @deepseek-ai/dsh-agents/run
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import {
  renderWorkerBrief,
  type AcceptWorktreeRequest,
  type DirtySummary,
  type WorktreeId,
  type WorktreeRecord,
  type WorktreeRoute,
} from '@deepseek-ai/dsh-subagent-worktree'
import { performAccept } from './accept-cycle.ts'
import { renderFixerPrompt } from './fixer.ts'
import type { AgentsIo } from './io.ts'
import { writeLine } from './io.ts'
import { createOperatorAgent, releaseOperatorAgent, resolveCwd } from './operator.ts'
import { isFixable, workerEvent, workerLine, worktreeEvent, worktreeLine } from './render.ts'
import { internals } from './runner-internals.ts'
import {
  deriveLabel, required, resolveReviewerOverride, resolveWorkDir, resolveWorkerRoute, splitTestCommand, toModelSelection,
} from './route.ts'
import type { AgentsStartupValues } from './startup.ts'

/** One resolved worktree ready for a worker, whichever path provided it. */
interface ResolvedWorktree {
  readonly record: WorktreeRecord
  readonly workDir: string
  readonly reused: boolean
  readonly baseDirty?: DirtySummary
}

/**
 * Create a fresh worktree, or reuse the `open` one named by `--worktree`. The
 * reuse lookup omits `owner`, so it is the operator view of every worktree of
 * the invoking repository, not just ones the operator itself created — the
 * same reach `accept`/`discard` have.
 * @param ctx - plugin context carrying `ctx.subagentWorktrees`.
 * @param cwd - the invoking directory.
 * @param worktreeId - raw `--worktree` value, or undefined to create one.
 * @param label - the display label for a freshly created worktree.
 * @param task - the task text recorded for review on a freshly created worktree.
 * @param workerRoute - the worker route recorded on a freshly created worktree.
 * @param signal - cancellation for the git work.
 * @returns the resolved record, its worker directory, and whether it was reused.
 * @throws when `--worktree` names an id with no matching record in this repository, or one that is not `open`.
 */
async function resolveWorktree(
  ctx: Context,
  cwd: string,
  worktreeId: string | undefined,
  label: string,
  task: string,
  workerRoute: WorktreeRoute,
  signal: AbortSignal,
): Promise<ResolvedWorktree> {
  if (worktreeId === undefined) {
    const provisioned = await ctx.subagentWorktrees.create({
      owner: { kind: 'operator' }, baseDir: cwd, label, task, workerRoute, signal,
    })
    return {
      record: provisioned.record,
      workDir: provisioned.workDir,
      reused: false,
      ...provisioned.baseDirty === undefined ? {} : { baseDirty: provisioned.baseDirty },
    }
  }
  const id = brandString<WorktreeId>(worktreeId)
  const records = await ctx.subagentWorktrees.list({ baseDir: cwd, includeClosed: true })
  const record = records.find(candidate => candidate.id === id)
  if (record === undefined) throw new Error(`worktree "${id}" was not found for this repository`)
  if (record.state !== 'open') throw new Error(`worktree "${id}" is ${record.state}, not open`)
  return { record, workDir: resolveWorkDir(record, cwd), reused: true }
}

/**
 * Start one foreground child (the worker or a fixer) in the worktree and
 * settle it in a `finally`: the worktree service learns about the child as
 * soon as it is published, regardless of how its turn later settles; the run
 * is always disposed; and a `run.result` rejection (an infrastructure fault
 * the seam cannot represent as a stop reason) aborts the child's own signal
 * before the fault propagates to the caller.
 * @param ctx - plugin context carrying `ctx.subagents` and `ctx.subagentWorktrees`.
 * @param worktreeId - the worktree the child works in.
 * @param operator - the delegating parent Agent.
 * @param label - the child's display label.
 * @param workDir - the child's working directory (the worktree's own directory).
 * @param prompt - the child's complete initial prompt text.
 * @param route - the route the child runs on.
 * @param io - process-facing effects.
 * @param json - whether this invocation asked for the machine-readable stream.
 * @throws the run's own rejection, after the worktree service has recorded the child and its resources are released.
 */
async function runChildAndAttach(
  ctx: Context,
  worktreeId: WorktreeId,
  operator: Agent,
  label: string,
  workDir: string,
  prompt: string,
  route: WorktreeRoute,
  io: AgentsIo,
  json: boolean,
): Promise<void> {
  const controller = new AbortController()
  const run = await ctx.subagents.start('spawn', {
    parent: operator,
    label,
    prompt: [{ type: 'text', text: prompt }],
    cwd: workDir,
    agentOptions: toModelSelection(route),
    signal: controller.signal,
  })
  let result: SubagentResult | undefined
  try {
    result = await run.result
  } finally {
    if (result === undefined) controller.abort('subagent run settlement failed')
    // The child is published once start() resolves; record it now so the
    // service knows about it regardless of how its turn settled.
    await ctx.subagentWorktrees.attach({ id: worktreeId, owner: { kind: 'operator' }, workerSessionId: run.id, workerRoute: route })
    await run.dispose()
  }
  writeLine(
    io, json,
    workerEvent(run.id, route, result.stopReason, result.diagnostic),
    workerLine(run.id, route, result.stopReason),
  )
}

/**
 * Run the complete `run` verb: resolve routes, fail fast on an
 * unreviewable route pairing, create or reuse the worktree, run the worker,
 * accept, and spend up to `--fix-rounds` fixer attempts on a fixable outcome.
 * Exits `0` (merged), `2` (every other settled outcome), matching
 * {@link exitCodeForOutcome}. The operator Agent is flushed and released in a
 * `finally`, on both the success and the failure path.
 * @param ctx - plugin context carrying `ctx.subagentWorktrees`, `ctx.subagents`, `ctx.agentDefaultModel`, and `ctx.agents`.
 * @param config - the parsed `run` verb values.
 * @param io - process-facing effects.
 */
export async function runVerb(ctx: Context, config: AgentsStartupValues, io: AgentsIo): Promise<void> {
  const requested = required(config.task, 'agents-runner: run config is missing its task')
  const operatorRoute = ctx.agentDefaultModel.currentSelection()
  const workerRoute = resolveWorkerRoute(config.model, config.effort, operatorRoute)
  const reviewerOverride = resolveReviewerOverride(config.reviewer, config.reviewerEffort)
  const controller = new AbortController()

  // Fail fast: before reading stdin, before the operator Agent, before the
  // worktree, before the worker. A wasted worktree or worker run is the exact
  // cost this order avoids.
  ctx.subagentWorktrees.resolveReviewer({
    workerRoute, callerRoute: operatorRoute, ...reviewerOverride === undefined ? {} : { override: reviewerOverride },
  })

  const task = requested === '-' ? await internals.readStdin() : requested
  if (task.trim() === '') {
    throw new Error('a task is required, for example: dsh agents run "add the parser and its tests"')
  }

  const cwd = await resolveCwd(ctx)
  const handle = await createOperatorAgent(ctx, cwd, operatorRoute)
  try {
    const operator = handle.agent
    const label = config.name ?? deriveLabel(task)

    const { record, workDir, reused, baseDirty } = await resolveWorktree(
      ctx, cwd, config.worktree, label, task, workerRoute, controller.signal,
    )
    writeLine(io, config.json, worktreeEvent(record, reused, baseDirty), worktreeLine(record, reused, baseDirty))

    const brief = renderWorkerBrief({ workDir, branch: record.branch, baseCommit: record.baseCommit, repoRoot: record.repoRoot })
    await runChildAndAttach(ctx, record.id, operator, label, workDir, brief + task, workerRoute, io, config.json)

    const testCommand = config.test === undefined ? undefined : splitTestCommand(config.test)
    const acceptRequest = (): AcceptWorktreeRequest => ({
      id: record.id,
      owner: { kind: 'operator' },
      parent: operator,
      ...reviewerOverride === undefined ? {} : { reviewer: reviewerOverride },
      ...testCommand === undefined ? {} : { testCommand },
      signal: controller.signal,
    })

    let cycle = await performAccept(ctx, acceptRequest(), io, config.json)
    const fixRounds = config.fixRounds ?? 0
    for (let round = 0; isFixable(cycle.outcome) && round < fixRounds; round += 1) {
      // Same brief as the first worker: without it a fixer does not know its
      // worktree, branch, base commit, or that git write commands fail there.
      const fixerPrompt = brief + renderFixerPrompt(task, cycle.outcome)
      await runChildAndAttach(ctx, record.id, operator, `Fix ${label}`, workDir, fixerPrompt, workerRoute, io, config.json)
      cycle = await performAccept(ctx, acceptRequest(), io, config.json)
    }

    io.exit(cycle.exitCode)
  } finally {
    await releaseOperatorAgent(ctx, handle)
  }
}
