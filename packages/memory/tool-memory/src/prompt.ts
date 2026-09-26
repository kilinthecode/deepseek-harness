/**
 * The static prompt section that tells the model what durable memory is for
 * and when to use it. Tool definitions say what each tool and parameter does;
 * this section says when to call them.
 * @module @deepseek-ai/dsh-tool-memory/src/prompt
 */

/** Section text registered at the `TOOL_MEMORY` position. */
export const MEMORY_SECTION_TEXT =
  'You have durable memory that persists across sessions. When saved memories exist, one snapshot of them '
  + 'is added to the conversation when it starts: some entries with their full content, the rest as a '
  + 'one-line index. The snapshot is not refreshed during the conversation; after context compaction a '
  + 'new snapshot is added. Memories you write or forget now are confirmed in the tool results and appear '
  + 'in the next snapshot. Call memory_recall to read an entry the snapshot lists only as an index line, '
  + 'or to find memories saved after the snapshot. Save a memory with memory_write when you learn a fact '
  + 'that stays true in every session. Write declarative statements, not imperatives: "The user prefers '
  + 'concise answers", not "Always answer concisely". Do not save task progress, transient state, secrets, '
  + 'or anything the repository already records. Remove a memory that is wrong or no longer applies with '
  + 'memory_forget.'
