import type { ToolEntry } from './tools.ts';

/**
 * The tools this build ships. The tool registry (T-04, #12) replaces this list with the entries
 * generated from the tool manifests; until a tool exists the shell shows its empty state.
 */
export const TOOL_ENTRIES: readonly ToolEntry[] = [];
