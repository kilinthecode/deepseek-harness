# Agent Crew

Split a goal into independently verifiable parts, hand each to a worker agent in its own git worktree, and land only the parts an independent reviewer confirms are correct.

## When to use

- The goal has two or more parts that touch disjoint files or modules and can be described, built, and checked independently.
- A change is risky or unfamiliar enough that an independent reviewer's pass-or-fail verdict is worth the extra round trip.
- You would otherwise spend your own context reading a large diff you can instead judge by verdict and summary.

## When not to use

Do not use this for a small, single-step edit, a change that must land as one atomic commit, or a task with no natural split. Spawning a crew adds a worktree, a commit, a review round trip, and a merge for every part; that overhead pays off only when parts are genuinely independent. Skip it too when a part has no objective acceptance check — a reviewer that cannot verify anything concrete degrades to a coin flip.

## Decompose the goal

Give each part a disjoint file or directory scope: two workers editing the same file conflict at merge time, not before. For every part, write down:

- the exact scope — the files, directories, or modules it owns;
- constraints it must respect — conventions, APIs it must not change, packages it must not touch;
- an acceptance criterion a reviewer with no other context can check: a test that must pass, a behavior to demonstrate, a command whose output should show something specific.

A part with no acceptance criterion is not ready to hand off.

## Write the worker's brief

Give each worker everything it needs and nothing it must guess. A brief that omits context makes the worker re-derive it, or assume something wrong; one that includes irrelevant history wastes the worker's own budget. Cover:

1. **Goal context** — the one or two sentences of the larger goal this part serves, so the worker can make good calls at the edges of its scope.
2. **Exact scope** — the files or directories it owns, and what is explicitly out of scope.
3. **Constraints** — anything it must not do (touch another part's files, change a public API, add a dependency).
4. **Acceptance checks** — the concrete criterion from decomposition, stated as something the worker can run or demonstrate before finishing.
5. **What to report** — ask it to end with the commands it ran, their results, and anything it did not verify.

## Spawn one worker per part

Start every worker in one assistant message so they run in parallel, each with `isolation: "worktree"` so its changes cannot overwrite yours or another worker's:

```
subagent({
  description: "<short label>",
  prompt: "<the worker's brief>",
  isolation: "worktree",
  provider: "<cheaper provider than your own, if the tool offers one>",
  model: "<cheaper model than your own, if the tool offers one>",
})
```

Prefer a worker model cheaper than your own when the tool exposes `provider`/`model`: a decomposed, well-specified part needs less capability than the planning you already did. Never use `subagent_fork` for a crew member — it has no model selection and inherits your conversation, defeating both the cost saving and the context isolation this skill exists for.

Keep your own context small while workers run: read their results and the reviewer's verdict, not their transcripts. After a resume or a compaction, call `list_worktrees` to recover which open worktree belongs to which part instead of guessing.

## Land, fix, or discard each part

When a worker finishes, call `accept_worktree` for its worktree. The harness commits the worker's changes, runs any configured checks, and has an independent reviewer check that exact commit before merging:

- **Merged** — done; move to the next part.
- **Rejected**, or **checks failed** — send the returned findings to the worker with `send_message`, wait for it to finish, then call `accept_worktree` again. Forward the findings; do not re-derive or soften them yourself.
- **Conflict** — another part already merged something overlapping. Merge the branch yourself and resolve it, or call `discard_worktree` if the part is no longer needed.
- **Blocked** — your own checkout has uncommitted changes in the way; commit or set them aside, then accept again.

Call `discard_worktree` for a part you abandon or replace, so it stops holding a branch open.

## Report back

Finish with one line per part: its outcome, the merge commit when it landed, and the reviewer's summary. Stating that evidence, not just "done," is what makes the independent review worth something.

## Outside the app

A person or an external agent runs the same loop from a shell with `dsh agents run`, which creates the worktree, starts the worker, and accepts the result in one command; `dsh agents list`, `accept`, and `discard` manage the rest.
