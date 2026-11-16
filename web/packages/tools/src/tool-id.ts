/** Longest tool id in characters; ids end up in URLs and file names. */
export const TOOL_ID_MAX_LENGTH = 48;

/** Lowercase ASCII words joined by single hyphens; starts with a letter, never ends in a hyphen. */
const TOOL_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

declare const toolIdBrand: unique symbol;

/** A tool id that went through {@link parseToolId}; plain strings do not type-check as one. */
export type ToolId = string & { readonly [toolIdBrand]: true };

export type ToolIdError = 'empty' | 'too-long' | 'invalid-characters';

export type ToolIdResult =
  | { readonly ok: true; readonly value: ToolId }
  | { readonly ok: false; readonly error: ToolIdError };

/** Parses `input` into a {@link ToolId}; the only way to obtain one. */
export function parseToolId(input: string): ToolIdResult {
  if (input.length === 0) {
    return { ok: false, error: 'empty' };
  }
  if (input.length > TOOL_ID_MAX_LENGTH) {
    return { ok: false, error: 'too-long' };
  }
  if (!TOOL_ID_PATTERN.test(input)) {
    return { ok: false, error: 'invalid-characters' };
  }
  return { ok: true, value: input as ToolId };
}
