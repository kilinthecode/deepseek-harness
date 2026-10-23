/**
 * Scripted `ctx.subagentWorktrees` stand-in. The real service is implemented
 * in a parallel worktree; these tests exercise the tool package's own wiring
 * (owner, parent, baseDir, error surfacing) against a fake with the service's
 * exact public methods, recording every request it receives.
 * @module fake-subagent-worktrees
 */

import SubagentWorktreesService from '@deepseek-ai/dsh-subagent-worktree'
import type {
  AcceptOutcome,
  AcceptWorktreeRequest,
  AttachWorkerRequest,
  CreateWorktreeRequest,
  DiscardWorktreeRequest,
  ListWorktreesRequest,
  ProvisionedWorktree,
  ResolveReviewerRequest,
  WorktreeRecord,
  WorktreeRoute,
} from '@deepseek-ai/dsh-subagent-worktree'

/**
 * Test double for `SubagentWorktrees`. Declares no service dependencies of
 * its own (the real class requires `subprocess` and `subagents`, which these
 * tool-focused tests have no reason to mount), and every method is scripted
 * or records its request and throws, so a test that forgets to script a path
 * fails loudly instead of silently returning `undefined`.
 */
export class FakeSubagentWorktrees extends SubagentWorktreesService {
  static override inject: string[] = []

  readonly acceptCalls: AcceptWorktreeRequest[] = []
  readonly discardCalls: DiscardWorktreeRequest[] = []
  readonly listCalls: ListWorktreesRequest[] = []

  acceptImpl?: (request: AcceptWorktreeRequest) => Promise<AcceptOutcome>
  discardImpl?: (request: DiscardWorktreeRequest) => Promise<WorktreeRecord>
  listImpl?: (request: ListWorktreesRequest) => Promise<WorktreeRecord[]>

  override create(request: CreateWorktreeRequest): Promise<ProvisionedWorktree> {
    void request
    throw new Error('FakeSubagentWorktrees.create is not used by these tests')
  }

  override attach(request: AttachWorkerRequest): Promise<WorktreeRecord> {
    void request
    throw new Error('FakeSubagentWorktrees.attach is not used by these tests')
  }

  override resolveReviewer(request: ResolveReviewerRequest): WorktreeRoute {
    void request
    throw new Error('FakeSubagentWorktrees.resolveReviewer is not used by these tests')
  }

  override accept(request: AcceptWorktreeRequest): Promise<AcceptOutcome> {
    this.acceptCalls.push(request)
    if (!this.acceptImpl) throw new Error('FakeSubagentWorktrees.accept: no scripted implementation for this test')
    return this.acceptImpl(request)
  }

  override discard(request: DiscardWorktreeRequest): Promise<WorktreeRecord> {
    this.discardCalls.push(request)
    if (!this.discardImpl) throw new Error('FakeSubagentWorktrees.discard: no scripted implementation for this test')
    return this.discardImpl(request)
  }

  override list(request: ListWorktreesRequest): Promise<WorktreeRecord[]> {
    this.listCalls.push(request)
    if (!this.listImpl) throw new Error('FakeSubagentWorktrees.list: no scripted implementation for this test')
    return this.listImpl(request)
  }
}
