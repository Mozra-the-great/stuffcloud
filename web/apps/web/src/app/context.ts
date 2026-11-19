import { getContext, setContext } from 'svelte';
import type { ToolEntry } from './tools.ts';

const TOOLS = Symbol('stuffcloud.tools');

/** Makes the tool list available to the shell's pages and the search (read it with `getTools`). */
export function provideTools(tools: () => readonly ToolEntry[]): void {
  setContext(TOOLS, tools);
}

export function getTools(): readonly ToolEntry[] {
  const tools = getContext<(() => readonly ToolEntry[]) | undefined>(TOOLS);
  if (tools === undefined) {
    throw new Error('getTools() needs a parent that called provideTools()');
  }
  return tools();
}
