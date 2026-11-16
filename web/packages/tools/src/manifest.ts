import { parseToolId, type ToolId } from './tool-id.ts';

/** What every tool module declares about itself; the registry (T-04) is built from these. */
export interface ToolManifest {
  readonly id: ToolId;
}

/** Builds a manifest and throws a `RangeError` naming the rule when the id is not a valid tool id. */
export function defineTool(id: string): ToolManifest {
  const parsed = parseToolId(id);
  if (!parsed.ok) {
    throw new RangeError(`invalid tool id ${JSON.stringify(id)}: ${parsed.error}`);
  }
  return { id: parsed.value };
}
