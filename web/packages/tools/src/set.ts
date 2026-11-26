import type { ToolManifest } from './manifest.ts';
import { parseToolManifest, type ManifestIssue, type ManifestOptions } from './schema.ts';
import { parseToolId, type ToolId } from './tool-id.ts';

export type ToolSetResult<K extends string = string, M = unknown> =
  | { readonly ok: true; readonly manifests: readonly ToolManifest<K, M>[] }
  | { readonly ok: false; readonly issues: readonly ManifestIssue[] };

/**
 * Checks a whole set of manifests: each one against the schema (issue paths start with the tool
 * id, or `#<position>` when it has no usable id), and the ids against each other. Valid input
 * comes back sorted by category order, then id, so navigation does not depend on file order.
 */
export function parseToolSet<K extends string = string, M = unknown>(
  inputs: readonly unknown[],
  categoryOrder: readonly string[],
  options: ManifestOptions = {},
): ToolSetResult<K, M> {
  const issues: ManifestIssue[] = [];
  const manifests: ToolManifest<K, M>[] = [];
  const firstSeen = new Map<string, number>();
  inputs.forEach((input, index) => {
    const result = parseToolManifest<K, M>(input, options);
    const rawId = (input as { readonly id?: unknown } | null | undefined)?.id;
    const label = typeof rawId === 'string' && rawId !== '' ? rawId : `#${String(index)}`;
    if (!result.ok) {
      for (const issue of result.issues) {
        issues.push({ ...issue, path: issue.path === '' ? label : `${label}.${issue.path}` });
      }
      return;
    }
    const earlier = firstSeen.get(result.value.id);
    if (earlier === undefined) {
      firstSeen.set(result.value.id, index);
      manifests.push(result.value);
    } else {
      issues.push({
        path: label,
        code: 'duplicate-id',
        message: `id ${JSON.stringify(result.value.id)} is already used by the tool at position ${String(earlier)}`,
      });
    }
  });
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const rank = (manifest: ToolManifest<K, M>): number => categoryOrder.indexOf(manifest.category);
  // Stryker disable next-line EqualityOperator: two manifests never share an id (duplicates are an issue above), so `<` and `<=` order every pair the same way
  manifests.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
  return { ok: true, manifests };
}

/** The tool configuration file (`tools.config.json`): which tools this build switches off. */
export interface ToolsConfig {
  readonly disabled: readonly ToolId[];
}

export type ToolsConfigResult =
  | { readonly ok: true; readonly value: ToolsConfig }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Parses the configuration. Unknown fields, malformed ids, duplicates and ids of tools that do
 * not exist are errors: a typo must not leave a tool enabled by accident (or a removed tool
 * listed forever). `known` are the ids of the tools that exist.
 */
export function parseToolsConfig(input: unknown, known: ReadonlySet<string>): ToolsConfigResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, issues: ['the configuration must be an object { "disabled": [...] }'] };
  }
  const record = input as Readonly<Record<string, unknown>>;
  const issues: string[] = [];
  for (const key of Object.keys(record)) {
    if (key !== 'disabled') {
      issues.push(`${key}: is not a configuration field (disabled)`);
    }
  }
  const disabled: ToolId[] = [];
  const list = Object.hasOwn(record, 'disabled') ? record['disabled'] : undefined;
  if (!Array.isArray(list)) {
    issues.push('disabled: must be an array of tool ids');
  } else {
    const seen = new Set<string>();
    (list as readonly unknown[]).forEach((entry, index) => {
      const path = `disabled[${String(index)}]`;
      const parsed = typeof entry === 'string' ? parseToolId(entry) : undefined;
      if (parsed?.ok !== true) {
        issues.push(`${path}: must be a valid tool id`);
      } else if (seen.has(parsed.value)) {
        issues.push(`${path}: ${JSON.stringify(parsed.value)} is listed twice`);
      } else if (!known.has(parsed.value)) {
        issues.push(`${path}: there is no tool ${JSON.stringify(parsed.value)}`);
      } else {
        seen.add(parsed.value);
        disabled.push(parsed.value);
      }
    });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { disabled } };
}
