import { describe, expect, it } from 'vitest';
import {
  BUDGET_LIMITS,
  CAPABILITIES,
  isCapability,
  isStickerName,
  isToolCategory,
  parseToolManifest,
  parseToolsConfig,
  STICKER_NAMES,
  TOOL_CATEGORIES,
  type ManifestIssue,
} from '../src/index.ts';
import { mutate, validInput } from './fixtures.ts';

function issuesOf(input: unknown): ManifestIssue[] {
  const result = parseToolManifest(input);
  return result.ok ? [] : [...result.issues];
}

/** The wording of every issue is part of the contract: it tells a tool author what to fix. */
describe('parseToolManifest: the exact issues', () => {
  it('names the missing budget fields and the ones that are not budget fields', () => {
    expect(issuesOf(mutate({ budget: { scriptKb: 1, extra: 2 } }))).toEqual([
      {
        path: 'budget.extra',
        code: 'invalid-budget',
        message: 'is not a budget field (scriptKb, assetsKb)',
      },
      {
        path: 'budget.assetsKb',
        code: 'invalid-budget',
        message: `must be a whole number of KiB from 0 to ${String(BUDGET_LIMITS.assetsKb)}`,
      },
    ]);
  });

  it('wants an object for the budget', () => {
    expect(issuesOf(mutate({ budget: 5 }))).toEqual([
      {
        path: 'budget',
        code: 'invalid-budget',
        message: 'must be an object { scriptKb, assetsKb }',
      },
    ]);
    expect(issuesOf(mutate({ budget: [] }))).toEqual([
      {
        path: 'budget',
        code: 'invalid-budget',
        message: 'must be an object { scriptKb, assetsKb }',
      },
    ]);
  });

  it.each([
    ['a string', '5'],
    ['null', null],
    ['undefined', undefined],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['a negative number', -1],
    ['a number over the limit', BUDGET_LIMITS.scriptKb + 1],
  ])('refuses %s as the script budget, naming the range', (_name, scriptKb) => {
    expect(issuesOf(mutate({ budget: { scriptKb, assetsKb: 0 } }))).toEqual([
      {
        path: 'budget.scriptKb',
        code: 'invalid-budget',
        message: `must be a whole number of KiB from 0 to ${String(BUDGET_LIMITS.scriptKb)}`,
      },
    ]);
  });

  it('accepts both ends of the budget range and nothing else is reported', () => {
    expect(issuesOf(mutate({ budget: { scriptKb: 0, assetsKb: BUDGET_LIMITS.assetsKb } }))).toEqual(
      [],
    );
    expect(issuesOf(mutate({ budget: { scriptKb: BUDGET_LIMITS.scriptKb, assetsKb: 0 } }))).toEqual(
      [],
    );
  });

  it('wants an array for requires and names the possible entries', () => {
    expect(issuesOf(mutate({ requires: 'worker' }))).toEqual([
      {
        path: 'requires',
        code: 'invalid-requires',
        message: `must be an array (possible entries: ${CAPABILITIES.join(', ')})`,
      },
    ]);
  });

  it.each([5, null, undefined, {}, [], 'gpu', 'Worker', '', 'constructor', 'toString'])(
    'refuses %j as a capability',
    (entry) => {
      const shown = typeof entry === 'string' ? JSON.stringify(entry) : typeof entry;
      expect(issuesOf(mutate({ requires: ['worker', entry] }))).toEqual([
        {
          path: 'requires[1]',
          code: 'unknown-capability',
          message: `${shown} is not a capability (${CAPABILITIES.join(', ')})`,
        },
      ]);
    },
  );

  it('names a capability that is listed twice', () => {
    expect(issuesOf(mutate({ requires: ['worker', 'wasm', 'worker'] }))).toEqual([
      { path: 'requires[2]', code: 'duplicate-capability', message: 'worker is listed twice' },
    ]);
  });

  it.each([5, null, undefined, {}, [], 'office', 'PDF', '', 'constructor'])(
    'refuses %j as a category',
    (category) => {
      const shown = typeof category === 'string' ? JSON.stringify(category) : typeof category;
      expect(issuesOf(mutate({ category }))).toEqual([
        {
          path: 'category',
          code: 'invalid-category',
          message: `${shown} is not a category (${TOOL_CATEGORIES.join(', ')})`,
        },
      ]);
    },
  );

  it.each([5, null, undefined, {}, [], 'unicorn', 'PDF-MERGE', '', 'constructor'])(
    'refuses %j as a sticker',
    (sticker) => {
      const shown = typeof sticker === 'string' ? JSON.stringify(sticker) : typeof sticker;
      expect(issuesOf(mutate({ sticker }))).toEqual([
        {
          path: 'sticker',
          code: 'invalid-sticker',
          message: `${shown} is not a design sticker (${STICKER_NAMES.join(', ')})`,
        },
      ]);
    },
  );

  it('names the unknown property and the known ones', () => {
    const issues = issuesOf({ ...validInput(), colour: 'red' });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('colour');
    expect(issues[0]?.code).toBe('unknown-property');
    expect(issues[0]?.message).toBe(
      'is not a manifest field (id, category, nameKey, descriptionKey, keywordsKey, sticker, runsIn, fileContent, requires, budget, load)',
    );
  });

  it('says what a text key must be when the id is usable', () => {
    expect(issuesOf(mutate({ nameKey: 'tool.other.name' }))).toEqual([
      {
        path: 'nameKey',
        code: 'invalid-key',
        message: 'must be "tool.pdf-merge.name", got "tool.other.name"',
      },
    ]);
    expect(issuesOf(mutate({ descriptionKey: 7 }))).toEqual([
      {
        path: 'descriptionKey',
        code: 'invalid-key',
        message: 'must be "tool.pdf-merge.description", got number',
      },
    ]);
  });

  it('only asks for a string as the text key when the id is unusable', () => {
    const issues = issuesOf(mutate({ id: 'Bad Id', nameKey: 5, descriptionKey: 'anything' }));
    expect(issues.filter((issue) => issue.path === 'nameKey')).toEqual([
      { path: 'nameKey', code: 'invalid-key', message: 'must be a message key string' },
    ]);
    expect(issues.filter((issue) => issue.path === 'descriptionKey')).toEqual([]);
  });

  it('says where the runsIn value must be client or server, and why server is refused', () => {
    expect(issuesOf(mutate({ runsIn: 'cloud' }))).toEqual([
      {
        path: 'runsIn',
        code: 'invalid-runs-in',
        message: '"cloud" must be "client" or "server"',
      },
    ]);
    expect(issuesOf(mutate({ runsIn: 5 }))).toEqual([
      { path: 'runsIn', code: 'invalid-runs-in', message: 'number must be "client" or "server"' },
    ]);
    expect(issuesOf(mutate({ runsIn: 'server' }))).toEqual([
      {
        path: 'runsIn',
        code: 'server-not-allowed',
        message:
          'server tools are not allowed in v1: files must not leave the browser (ADR 0004, ADR 0012)',
      },
    ]);
  });

  it('says what the load field must be', () => {
    expect(issuesOf(mutate({ load: 'x' }))).toEqual([
      {
        path: 'load',
        code: 'invalid-load',
        message:
          'must be a function that returns the tool page, for example () => import("./Tool.svelte")',
      },
    ]);
  });

  it('says what the file content promise must be', () => {
    expect(issuesOf(mutate({ fileContent: 'uploads' }))).toEqual([
      {
        path: 'fileContent',
        code: 'invalid-file-content',
        message: 'must be "stays-in-browser": a tool never sends file content anywhere',
      },
    ]);
  });

  it('says what the id must be', () => {
    expect(issuesOf(mutate({ id: 7 })).find((issue) => issue.path === 'id')).toEqual({
      path: 'id',
      code: 'invalid-id',
      message: 'must be a string',
    });
    expect(issuesOf(mutate({ id: '' })).find((issue) => issue.path === 'id')).toEqual({
      path: 'id',
      code: 'invalid-id',
      message: '"" must not be empty',
    });
    expect(issuesOf(mutate({ id: 'a'.repeat(49) })).find((issue) => issue.path === 'id')).toEqual({
      path: 'id',
      code: 'invalid-id',
      message: `"${'a'.repeat(49)}" must be at most 48 characters`,
    });
    expect(issuesOf(mutate({ id: 'Bad' })).find((issue) => issue.path === 'id')).toEqual({
      path: 'id',
      code: 'invalid-id',
      message:
        '"Bad" must be lowercase letters and digits in words joined by single hyphens, starting with a letter',
    });
  });

  it('says that a manifest must be an object', () => {
    expect(issuesOf(null)).toEqual([
      { path: '', code: 'not-an-object', message: 'a manifest must be an object' },
    ]);
  });
});

describe('the guards of the vocabulary', () => {
  it('refuse everything that is not a listed name, whatever its type', () => {
    for (const value of [5, null, undefined, {}, [], true, '', 'Worker', 'constructor']) {
      expect(isCapability(value)).toBe(false);
      expect(isToolCategory(value)).toBe(false);
      expect(isStickerName(value)).toBe(false);
    }
  });
});

describe('parseToolsConfig: entries that are not strings', () => {
  const known = new Set(['pdf-merge']);

  it.each([null, undefined, 5, true, {}, [], ['pdf-merge']])(
    'reports %j as not a valid tool id and does not throw',
    (entry) => {
      expect(parseToolsConfig({ disabled: [entry] }, known)).toEqual({
        ok: false,
        issues: ['disabled[0]: must be a valid tool id'],
      });
    },
  );
});
