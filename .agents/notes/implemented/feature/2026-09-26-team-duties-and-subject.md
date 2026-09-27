# Agent Note: Planner and executor duties and a Team subject

Status: implemented

English | [中文](2026-09-26-team-duties-and-subject.zh.md)

## Problem

Agent Teams lets a Lead create teammates and coordinate them through a mailbox and a shared task board, but every teammate is interchangeable: any member may create, claim, submit, and verify tasks, and nothing distinguishes the member that should decide what to build from the members that should build it. A user who wants the common plan-then-execute split has to describe it in prose every time, and nothing keeps a planning member from editing files itself.

A Team also has no statement of what it is for. Starting one means writing an ordinary first message, the conversation title comes from automatic titling, and the Web panel cannot say which goal the roster and tasks serve.

## Decision

A teammate may be created with a duty, `planner` or `executor`, a closed union named `TeamDuty` in `@deepseek-ai/dsh-experimental-agent-team`. The name `role` already means `lead` or `teammate` authority, so the new concept is `duty`. The duty is optional on `spawn_teammate`, `SpawnTeammateRequest`, the durable `team/member` snapshot, the roster view, and the `agentTeam` projection; a teammate without one keeps the unrestricted rules, which keeps every existing Team log valid. The duty is recorded on the first provisioning record and the projection refuses any change to it.

The Team service enforces the duty in the operation that makes each decision. `TeamMembership` carries the duty from the durable member record, and the task board refuses an executor's `create` and `verify`, a planner's `claim`, and a Lead reassignment onto a planner with `TEAM_DUTY_UNAUTHORIZED`. A planner may `edit`, `set_dependencies`, and `delete` a task that is unowned and pending, because a plan that its author cannot revise before execution starts would need the Lead for every correction. A teammate's `submit` notifies the Team's active planner, which verifies it; without an active planner the notice goes to the Lead as before.

A planner is read-only through the inherited tools it keeps, not through prompt text. `@deepseek-ai/dsh-experimental-tool-agent-team` owns `duties.<duty>.instructions` and `duties.<duty>.tools` in its `Config`; `tools` is `all` or an allow list, and the planner default lists only read tools. At creation the list is narrowed to tools the Lead can see and passed as `SpawnTeammateRequest.toolFilter`, which the Team service forwards to the subagent provider; the provider applies it with `tools.restrict()` in the child's creation window and reapplies it from the child's descriptor on every resume. An allow list fails closed: a write-capable tool added to a deployment later is hidden from planners until someone lists it. The Team tools are scoped registrations, so a restricted planner keeps them.

The Lead records a subject with `setSubject`, which appends a log-only `team/subject` event; the latest record wins, and the subject is at most 200 characters, like a task subject. The `/team <subject>` command in the tool package records the subject, pins the Session title through `sessionTitle.rename`, and steers the subject to the Lead as the user's message. While a Team has a subject, the shared `team:policy` section of every member ends with a paragraph that names the subject and the plan-then-execute flow the Lead runs. The Web start strip in `@deepseek-ai/dsh-experimental-client-ui-agent-team` sends the same command from a blank Lead conversation, and the Team panel heads its roster with the subject.

## Alternatives considered

**Carry the kickoff instructions in their own message.** Rejected because a message needs a source kind, and a new variant of the durable message-source union changes the finalized Session format 4 and would force a format bump for one command. A single user message that carried both the subject and the instructions would show the instructions in the user's own bubble. The policy paragraph keeps the first user message equal to the subject, is recorded in every request's system message, and renders identically for every member, so fork teammates keep the Lead's prefix.

**Deny write tools instead of allowing read tools.** Rejected because a deny list fails open: `workflow` starts full-tool children and `job_kill` stops peers' jobs, and any write-capable tool a deployment adds later would stay visible to planners. Schemastery also materializes an omitted array as an empty one, so an optional list would have turned an absent setting into "keep no tool"; `'all'` or an explicit list makes every materialized value mean what it says.

**Enforce duties only through their instructions.** Rejected because a prompt is not enforcement; a planner that edits files or an executor that verifies its own peers' work would go unnoticed. The service checks every task action and the tool restriction refuses execution, and tests deny both through their real operations.

**Hide duty-refused Team tools from the schema.** Rejected because Team schemas stay uniform across members, so a fork teammate keeps the Lead's prefix, and because schema omission does not stop a direct caller; the service refusal is the enforcement point.

**Deployment-defined duty names.** Rejected because no consumer needs a third duty, and a closed union lets the service, projection, and panel switch on it exhaustively; deployments configure only the instructions and tools of the two fixed duties.

**A new `agentTeams` Remote method for the start form.** Rejected because the Host command already resolves the Lead Agent for a blank Session, logs its own lifecycle, returns handler errors to the client through `commands/execute`, and gives command-capable clients the same entry point.

## Testing

`team.spec.ts` covers durable duty records, the forwarded restriction in the child's descriptor, every duty rule beside undutied members and the Lead, plan revision limited to unowned pending tasks, planner-routed submission notices with the Lead fallback when the only planner failed, and subject recording, bounds, and Lead-only authority. `projection-events.spec.ts` covers duty immutability, the closed duty set, latest-wins and empty-subject rejection, the republished view on a subject-only change, and the strict checkpoint round trip. `tool-team.spec.ts` covers the reminder text, the narrowed allow list and its refusal at execution, configured and empty tool lists, load-time instruction validation, the subject paragraph shared by the Lead and a teammate, and every `/team` outcome. The client specs cover the start strip's visibility rules, single submission, and in-place refusals, the command mapping, and the panel's subject heading and duty tags. `apps/cli/tests/agent-team-headless.e2e.ts` runs a planner and an executor through the shipped headless profile with a keyless adapter that fails if the planner ever sees a write tool, and `apps/web/tests/agent-team-start.e2e.ts` starts a Team from the strip in an assembled browser.

## Consequences

The plan-then-execute split is a product behavior instead of a prompt habit: a planner cannot change files through inherited tools or take work, an executor cannot redefine the plan or approve work, and the planner receives each submission without the Lead relaying it. A Team started from a subject has a pinned title, a heading in the panel, and a first message that is exactly what the user typed.

The costs are a subject paragraph of about 90 tokens in every member request of a Team with a subject, duty instructions of about 100 tokens once per dutied teammate, and a restricted planner whose tool schemas, and therefore request prefix, differ from the Lead's. A subject recorded after the Lead's first request changes every member's Team section once. `/team` exists only where a command registry is composed, so the one-shot headless runner, which sends its task as a user message, cannot start a Team with a subject. The Team projection checkpoint layout moved to version 6, and the persistence record `2026-09-26-team-duty-and-subject` acknowledges the optional duty property and the new event type without a Session format change.
