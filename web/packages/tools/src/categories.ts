/** Tool areas of SPEC 7, in navigation order. */
export const TOOL_CATEGORIES = [
  'pdf',
  'image',
  'convert',
  'parse',
  'network',
  'text',
  'extra',
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export function isToolCategory(value: string): value is ToolCategory {
  return (TOOL_CATEGORIES as readonly string[]).includes(value);
}
