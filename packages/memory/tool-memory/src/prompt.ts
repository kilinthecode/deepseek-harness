/**
 * The static prompt section that tells the model what durable memory is for
 * and when to use it. Tool definitions say what each tool and parameter does;
 * this section says when to call them.
 * @module @deepseek-ai/dsh-tool-memory/src/prompt
 */

/** Section text registered at the `TOOL_MEMORY` position. */
export const MEMORY_SECTION_TEXT =
  'You have durable memory that persists across sessions. When saved memories exist, a catalog of them '
  + '(type, name, one-line description) is added to the conversation; the most recent catalog is current, '
  + 'and changes appear in a new catalog at the start of a later turn. Call memory_recall to read a '
  + 'memory\'s content before relying on it. Save a memory with memory_write when you learn something '
  + 'worth keeping beyond this session; do not save task progress, transient state, secrets, or anything '
  + 'the repository already records. Remove a memory that is wrong or no longer applies with memory_forget.'
