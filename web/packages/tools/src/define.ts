import type { ToolManifest, ToolManifestInput } from './manifest.ts';
import { parseToolManifest, type ManifestIssue, type ManifestOptions } from './schema.ts';

/** `a.b: must ...` for every issue, one per line. */
export function formatIssues(issues: readonly ManifestIssue[]): string {
  return issues
    .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
    .map((line) => `  - ${line}`)
    .join('\n');
}

/** Thrown when a manifest (or the set of manifests) breaks the schema; carries every issue. */
export class ManifestError extends Error {
  readonly issues: readonly ManifestIssue[];

  constructor(subject: string, issues: readonly ManifestIssue[]) {
    super(`${subject} is invalid:\n${formatIssues(issues)}`);
    this.name = 'ManifestError';
    this.issues = issues;
  }
}

/**
 * Declares a tool. Checks the manifest against the schema and throws a {@link ManifestError}
 * listing every violated rule, so a broken manifest stops the build, the dev server and the
 * tests instead of showing up as a missing tool.
 */
export function defineTool<K extends string = string, M = unknown>(
  input: ToolManifestInput<K, M>,
  options: ManifestOptions = {},
): ToolManifest<K, M> {
  const result = parseToolManifest<K, M>(input, options);
  if (!result.ok) {
    const id = typeof input.id === 'string' ? input.id : '?';
    throw new ManifestError(`tool manifest ${JSON.stringify(id)}`, result.issues);
  }
  return result.value;
}
