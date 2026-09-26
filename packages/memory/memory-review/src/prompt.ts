/**
 * Model-visible review task and deny reasons owned by memory-review.
 * @module @deepseek-ai/dsh-memory-review/src/prompt
 */

/**
 * First new user-role message the review child receives after the inherited
 * parent prefix. The parent model never sees this text.
 */
export const REVIEW_PROMPT = 'This is an unattended memory review of the conversation above. '
  + 'Save a fact only if it remains true in every future session: who the user is and how they like to work (type user), '
  + 'feedback or corrections on how to do the work (type feedback), a durable fact or constraint about the current project (type project), '
  + 'or a pointer to an external resource (type reference). Write declarative statements, not imperatives. '
  + 'Prefer project scope for project facts, global otherwise. You may only add new memories: '
  + 'memory_write with an existing name and memory_forget are denied. Call memory_recall before writing if the snapshot lists only an index line. '
  + 'Do not save task progress, transient state, secrets, or anything the repository already records. '
  + 'If nothing qualifies, reply with exactly: Nothing to save.'

/** `subagent/catalog` label written on the parent when this plugin starts a child. */
export const REVIEW_LABEL = 'memory-review'

/** Deny reason when the child names a tool other than `memory_write` or `memory_recall`. */
export const REVIEW_DENY_OTHER_TOOL = 'Memory review may only call memory_write and memory_recall.'

/** Deny reason when the child calls `memory_forget` or `memory_write` for a name that already exists in that scope. */
export const REVIEW_DENY_OVERWRITE = 'Unattended memory review may only add a new name.'
