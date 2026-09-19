/**
 * The static prompt section that tells the model what durable memory is for
 * and when to use it. Tool descriptions say what each tool does; this section
 * says when.
 * @module @deepseek-ai/dsh-tool-memory/src/prompt
 */

/** Section text registered at the `TOOL_MEMORY` position. */
export const MEMORY_SECTION_TEXT =
  'You have durable memory that persists across sessions. A catalog of saved memories (type, name, '
  + 'one-line description) is added at the start of the session and refreshed when it changes; call '
  + 'memory_recall to read a memory\'s content before relying on it. Save a memory with memory_write '
  + 'when you learn something worth keeping beyond this session: who the user is and how they like to '
  + 'work (type user), feedback or corrections on how to do the work (type feedback), a durable fact or '
  + 'constraint about the current project (type project), or a pointer to an external resource such as '
  + 'a URL, ticket, or dashboard (type reference). Use scope project for facts about the current '
  + 'repository and scope global for everything else. Do not save task progress, transient state, '
  + 'secrets, or anything the repository already records. Writing an existing name in the same scope '
  + 'replaces it; remove a memory that turned out wrong with memory_forget.'
