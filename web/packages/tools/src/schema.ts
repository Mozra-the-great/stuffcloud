import { CAPABILITIES, isCapability, type Capability } from './capabilities.ts';
import { isToolCategory, TOOL_CATEGORIES } from './categories.ts';
import {
  FILE_CONTENT_STAYS_IN_BROWSER,
  toolTextKey,
  type RunsIn,
  type ToolBudget,
  type ToolManifest,
  type ToolTextField,
} from './manifest.ts';
import { isStickerName, STICKER_NAMES } from './stickers.ts';
import { parseToolId, TOOL_ID_MAX_LENGTH, type ToolIdError } from './tool-id.ts';

/** Largest budgets the schema accepts; a tool above them has to be split or justified in an ADR. */
export const BUDGET_LIMITS: Readonly<ToolBudget> = { scriptKb: 2048, assetsKb: 204_800 };

export type ManifestIssueCode =
  | 'not-an-object'
  | 'unknown-property'
  | 'missing-property'
  | 'invalid-id'
  | 'invalid-category'
  | 'invalid-key'
  | 'invalid-sticker'
  | 'invalid-runs-in'
  | 'server-not-allowed'
  | 'invalid-file-content'
  | 'invalid-requires'
  | 'unknown-capability'
  | 'duplicate-capability'
  | 'invalid-budget'
  | 'invalid-load'
  | 'duplicate-id'
  | 'missing-text';

/** One violated rule: where (`path`), which rule (`code`) and a sentence that names the fix. */
export interface ManifestIssue {
  readonly path: string;
  readonly code: ManifestIssueCode;
  readonly message: string;
}

export type ManifestResult<K extends string = string, M = unknown> =
  | { readonly ok: true; readonly value: ToolManifest<K, M> }
  | { readonly ok: false; readonly issues: readonly ManifestIssue[] };

export interface ManifestOptions {
  /** Accept `runsIn: 'server'`. Off in v1: a server tool needs the auth and hosting threat model. */
  readonly allowServer?: boolean;
}

const PROPERTIES = [
  'id',
  'category',
  'nameKey',
  'descriptionKey',
  'keywordsKey',
  'sticker',
  'runsIn',
  'fileContent',
  'requires',
  'budget',
  'load',
] as const;

type Property = (typeof PROPERTIES)[number];

const TEXT_KEY_FIELDS: readonly (readonly [Property, ToolTextField])[] = [
  ['nameKey', 'name'],
  ['descriptionKey', 'description'],
  ['keywordsKey', 'keywords'],
];

const ID_ERRORS: Readonly<Record<ToolIdError, string>> = {
  empty: 'must not be empty',
  'too-long': `must be at most ${String(TOOL_ID_MAX_LENGTH)} characters`,
  'invalid-characters':
    'must be lowercase letters and digits in words joined by single hyphens, starting with a letter',
};

function describe(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : typeof value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function budgetIssues(value: unknown): ManifestIssue[] {
  const issue = (path: string, message: string): ManifestIssue => ({
    path,
    code: 'invalid-budget',
    message,
  });
  if (!isRecord(value)) {
    return [issue('budget', 'must be an object { scriptKb, assetsKb }')];
  }
  const issues: ManifestIssue[] = [];
  for (const key of Object.keys(value)) {
    if (key !== 'scriptKb' && key !== 'assetsKb') {
      issues.push(issue(`budget.${key}`, 'is not a budget field (scriptKb, assetsKb)'));
    }
  }
  for (const field of ['scriptKb', 'assetsKb'] as const) {
    const limit = BUDGET_LIMITS[field];
    const entry = Object.hasOwn(value, field) ? value[field] : undefined;
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > limit) {
      issues.push(
        issue(`budget.${field}`, `must be a whole number of KiB from 0 to ${String(limit)}`),
      );
    }
  }
  return issues;
}

function requiresIssues(value: unknown): ManifestIssue[] {
  if (!Array.isArray(value)) {
    return [
      {
        path: 'requires',
        code: 'invalid-requires',
        message: `must be an array (possible entries: ${CAPABILITIES.join(', ')})`,
      },
    ];
  }
  const issues: ManifestIssue[] = [];
  const seen = new Set<string>();
  (value as readonly unknown[]).forEach((entry, index) => {
    const path = `requires[${String(index)}]`;
    if (typeof entry !== 'string' || !isCapability(entry)) {
      issues.push({
        path,
        code: 'unknown-capability',
        message: `${describe(entry)} is not a capability (${CAPABILITIES.join(', ')})`,
      });
    } else if (seen.has(entry)) {
      issues.push({ path, code: 'duplicate-capability', message: `${entry} is listed twice` });
    } else {
      seen.add(entry);
    }
  });
  return issues;
}

/**
 * Checks `input` against the manifest schema and reports every violated rule, not only the
 * first. Never throws, whatever `input` is. A valid manifest comes back as a frozen copy.
 */
export function parseToolManifest<K extends string = string, M = unknown>(
  input: unknown,
  options: ManifestOptions = {},
): ManifestResult<K, M> {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [{ path: '', code: 'not-an-object', message: 'a manifest must be an object' }],
    };
  }
  const issues: ManifestIssue[] = [];
  const known: readonly string[] = PROPERTIES;
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) {
      issues.push({
        path: key,
        code: 'unknown-property',
        message: `is not a manifest field (${PROPERTIES.join(', ')})`,
      });
    }
  }
  const present = (key: Property): boolean => Object.hasOwn(input, key);
  const field = (key: Property): unknown => (present(key) ? input[key] : undefined);
  for (const key of PROPERTIES) {
    if (!present(key)) {
      issues.push({ path: key, code: 'missing-property', message: 'is required' });
    }
  }

  const id = field('id');
  let idText = '';
  if (present('id')) {
    const parsed = typeof id === 'string' ? parseToolId(id) : undefined;
    if (parsed === undefined) {
      issues.push({ path: 'id', code: 'invalid-id', message: 'must be a string' });
    } else if (parsed.ok) {
      idText = parsed.value;
    } else {
      issues.push({
        path: 'id',
        code: 'invalid-id',
        message: `${describe(id)} ${ID_ERRORS[parsed.error]}`,
      });
    }
  }

  const category = field('category');
  if (present('category') && (typeof category !== 'string' || !isToolCategory(category))) {
    issues.push({
      path: 'category',
      code: 'invalid-category',
      message: `${describe(category)} is not a category (${TOOL_CATEGORIES.join(', ')})`,
    });
  }

  for (const [key, textField] of TEXT_KEY_FIELDS) {
    if (!present(key)) {
      continue;
    }
    const value = field(key);
    if (idText === '') {
      // Without a valid id the expected key is unknown; the id issue already explains it.
      if (typeof value !== 'string') {
        issues.push({ path: key, code: 'invalid-key', message: 'must be a message key string' });
      }
    } else if (value !== toolTextKey(idText, textField)) {
      issues.push({
        path: key,
        code: 'invalid-key',
        message: `must be ${JSON.stringify(toolTextKey(idText, textField))}, got ${describe(value)}`,
      });
    }
  }

  const sticker = field('sticker');
  if (present('sticker') && (typeof sticker !== 'string' || !isStickerName(sticker))) {
    issues.push({
      path: 'sticker',
      code: 'invalid-sticker',
      message: `${describe(sticker)} is not a design sticker (${STICKER_NAMES.join(', ')})`,
    });
  }

  const runsIn = field('runsIn');
  if (present('runsIn')) {
    if (runsIn !== 'client' && runsIn !== 'server') {
      issues.push({
        path: 'runsIn',
        code: 'invalid-runs-in',
        message: `${describe(runsIn)} must be "client" or "server"`,
      });
    } else if (runsIn === 'server' && options.allowServer !== true) {
      issues.push({
        path: 'runsIn',
        code: 'server-not-allowed',
        message:
          'server tools are not allowed in v1: files must not leave the browser (ADR 0004, ADR 0012)',
      });
    }
  }

  if (present('fileContent') && field('fileContent') !== FILE_CONTENT_STAYS_IN_BROWSER) {
    issues.push({
      path: 'fileContent',
      code: 'invalid-file-content',
      message: `must be ${JSON.stringify(FILE_CONTENT_STAYS_IN_BROWSER)}: a tool never sends file content anywhere`,
    });
  }

  if (present('requires')) {
    issues.push(...requiresIssues(field('requires')));
  }
  if (present('budget')) {
    issues.push(...budgetIssues(field('budget')));
  }
  if (present('load') && typeof field('load') !== 'function') {
    issues.push({
      path: 'load',
      code: 'invalid-load',
      message:
        'must be a function that returns the tool page, for example () => import("./Tool.svelte")',
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const budget = input['budget'] as ToolBudget;
  const manifest: ToolManifest<K, M> = {
    id: idText as ToolManifest['id'],
    category: input['category'] as ToolManifest['category'],
    nameKey: input['nameKey'] as K,
    descriptionKey: input['descriptionKey'] as K,
    keywordsKey: input['keywordsKey'] as K,
    sticker: input['sticker'] as ToolManifest['sticker'],
    runsIn: input['runsIn'] as RunsIn,
    fileContent: FILE_CONTENT_STAYS_IN_BROWSER,
    requires: Object.freeze([...(input['requires'] as readonly Capability[])]),
    budget: Object.freeze({ scriptKb: budget.scriptKb, assetsKb: budget.assetsKb }),
    load: input['load'] as () => Promise<M>,
  };
  return { ok: true, value: Object.freeze(manifest) };
}
