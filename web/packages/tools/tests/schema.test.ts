import { describe, expect, it } from 'vitest';
import {
  BUDGET_LIMITS,
  CAPABILITIES,
  FILE_CONTENT_STAYS_IN_BROWSER,
  parseToolManifest,
  STICKER_NAMES,
  TOOL_CATEGORIES,
  TOOL_ID_MAX_LENGTH,
  type ManifestIssue,
} from '../src/index.ts';
import { mutate, random, validInput } from './fixtures.ts';

function issuesOf(input: unknown, options?: { allowServer?: boolean }): ManifestIssue[] {
  const result = parseToolManifest(input, options);
  return result.ok ? [] : [...result.issues];
}

function only(input: unknown): ManifestIssue {
  const issues = issuesOf(input);
  expect(issues).toHaveLength(1);
  const [issue] = issues;
  if (issue === undefined) {
    throw new Error('expected one issue');
  }
  return issue;
}

describe('parseToolManifest: a valid manifest', () => {
  it('passes and comes back as a frozen copy', () => {
    const input = validInput();
    const result = parseToolManifest(input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual(input);
    expect(result.value).not.toBe(input);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.requires)).toBe(true);
    expect(Object.isFrozen(result.value.budget)).toBe(true);
  });

  it('does not follow later changes to the input', () => {
    const input = { ...validInput(), requires: ['wasm'], budget: { scriptKb: 1, assetsKb: 2 } };
    const result = parseToolManifest(input);
    input.requires.push('worker');
    input.budget.scriptKb = 99;
    expect(result.ok && result.value.requires).toEqual(['wasm']);
    expect(result.ok && result.value.budget).toEqual({ scriptKb: 1, assetsKb: 2 });
  });

  it('accepts every category, sticker and capability', () => {
    for (const category of TOOL_CATEGORIES) {
      expect(issuesOf(mutate({ category }))).toEqual([]);
    }
    for (const sticker of STICKER_NAMES) {
      expect(issuesOf(mutate({ sticker }))).toEqual([]);
    }
    expect(issuesOf(mutate({ requires: [...CAPABILITIES] }))).toEqual([]);
    expect(issuesOf(mutate({ requires: [] }))).toEqual([]);
  });
});

describe('parseToolManifest: the shape', () => {
  it.each([null, undefined, 'x', 42, true, [], [validInput()]])('rejects %j', (input) => {
    expect(issuesOf(input)).toEqual([
      { path: '', code: 'not-an-object', message: 'a manifest must be an object' },
    ]);
  });

  it('reports a missing field by name', () => {
    const rest: Record<string, unknown> = { ...validInput() };
    Reflect.deleteProperty(rest, 'budget');
    expect(issuesOf(rest)).toEqual([
      { path: 'budget', code: 'missing-property', message: 'is required' },
    ]);
  });

  it('reports every missing field of an empty object', () => {
    const codes = issuesOf({}).map((issue) => `${issue.path}:${issue.code}`);
    expect(codes).toHaveLength(11);
    expect(codes.every((code) => code.endsWith(':missing-property'))).toBe(true);
  });

  it('does not take an inherited field for a present one', () => {
    const inherited = Object.create({ id: 'pdf-merge' }) as Record<string, unknown>;
    const issues = issuesOf(inherited);
    expect(issues.some((issue) => issue.path === 'id' && issue.code === 'missing-property')).toBe(
      true,
    );
  });

  it('rejects a field the schema does not know (a typo is not ignored)', () => {
    const issue = only({ ...validInput(), catagory: 'pdf' });
    expect(issue.path).toBe('catagory');
    expect(issue.code).toBe('unknown-property');
    expect(issue.message).toContain('is not a manifest field');
  });

  it('reports several problems at once', () => {
    const codes = issuesOf(mutate({ category: 'nope', sticker: 'nope', runsIn: 'edge' })).map(
      (issue) => issue.code,
    );
    expect(codes).toEqual(['invalid-category', 'invalid-sticker', 'invalid-runs-in']);
  });
});

describe('parseToolManifest: id', () => {
  it('accepts the longest id', () => {
    const id = 'a'.repeat(TOOL_ID_MAX_LENGTH);
    expect(issuesOf(mutate({ id }, id))).toEqual([]);
  });

  it('rejects an id one character too long and says how long it may be', () => {
    const id = 'a'.repeat(TOOL_ID_MAX_LENGTH + 1);
    const issues = issuesOf(mutate({ id }, id));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: 'id', code: 'invalid-id' });
    expect(issues[0]?.message).toContain(`at most ${String(TOOL_ID_MAX_LENGTH)} characters`);
  });

  it('rejects an empty id', () => {
    const issues = issuesOf(mutate({ id: '' }, ''));
    expect(issues.find((issue) => issue.path === 'id')?.message).toContain('must not be empty');
  });

  it.each(['PDF', 'pdf_merge', '-pdf', 'pdf--x', '1pdf', '../x', 'pdf/x'])(
    'rejects the id %j',
    (id) => {
      const issue = issuesOf(mutate({ id }, id)).find((entry) => entry.path === 'id');
      expect(issue?.code).toBe('invalid-id');
      expect(issue?.message).toContain('lowercase letters and digits');
    },
  );

  it('rejects an id that is not a string', () => {
    const issue = issuesOf(mutate({ id: 7 })).find((entry) => entry.path === 'id');
    expect(issue).toEqual({ path: 'id', code: 'invalid-id', message: 'must be a string' });
  });
});

describe('parseToolManifest: category and sticker', () => {
  it('names the categories there are', () => {
    const issue = only(mutate({ category: 'office' }));
    expect(issue).toMatchObject({ path: 'category', code: 'invalid-category' });
    expect(issue.message).toContain(TOOL_CATEGORIES.join(', '));
  });

  it('rejects a category that is not a string', () => {
    expect(only(mutate({ category: 3 })).message).toContain('number is not a category');
  });

  it('rejects a sticker the design does not have', () => {
    const issue = only(mutate({ sticker: 'unicorn' }));
    expect(issue).toMatchObject({ path: 'sticker', code: 'invalid-sticker' });
    expect(issue.message).toContain('"unicorn"');
  });
});

describe('parseToolManifest: message keys', () => {
  it.each(['nameKey', 'descriptionKey', 'keywordsKey'])(
    '%s must follow the convention',
    (field) => {
      const issue = only(mutate({ [field]: 'tool.other.name' }));
      expect(issue.path).toBe(field);
      expect(issue.code).toBe('invalid-key');
      expect(issue.message).toContain('tool.pdf-merge.');
    },
  );

  it('rejects a key for the wrong text', () => {
    expect(only(mutate({ nameKey: 'tool.pdf-merge.description' })).message).toContain(
      '"tool.pdf-merge.name"',
    );
  });

  it('rejects a key that is not a string', () => {
    expect(only(mutate({ nameKey: 5 })).message).toContain('got number');
  });

  it('checks the key shape alone when the id is unusable', () => {
    const issues = issuesOf(mutate({ id: 'Bad', nameKey: 5 }, 'Bad'));
    expect(issues.map((issue) => issue.path)).toEqual(['id', 'nameKey']);
    expect(issues[1]?.message).toBe('must be a message key string');
  });

  it('accepts any string key when the id is unusable (the id issue explains it)', () => {
    const issues = issuesOf(mutate({ id: 'Bad' }, 'Bad'));
    expect(issues.map((issue) => issue.path)).toEqual(['id']);
  });
});

describe('parseToolManifest: runsIn and the file privacy promise', () => {
  it('rejects an unknown place', () => {
    expect(only(mutate({ runsIn: 'edge' }))).toMatchObject({
      path: 'runsIn',
      code: 'invalid-runs-in',
    });
  });

  it('refuses a server tool in v1', () => {
    const issue = only(mutate({ runsIn: 'server' }));
    expect(issue.code).toBe('server-not-allowed');
    expect(issue.message).toContain('files must not leave the browser');
  });

  it('accepts a server tool only when the caller allows it', () => {
    expect(issuesOf(mutate({ runsIn: 'server' }), { allowServer: true })).toEqual([]);
    expect(issuesOf(mutate({ runsIn: 'server' }), { allowServer: false })).toHaveLength(1);
  });

  it.each(['sent-to-server', '', true, null, 'STAYS-IN-BROWSER'])(
    'requires fileContent to be exactly "stays-in-browser" (not %j)',
    (value) => {
      const issue = only(mutate({ fileContent: value }));
      expect(issue).toMatchObject({ path: 'fileContent', code: 'invalid-file-content' });
      expect(issue.message).toContain(FILE_CONTENT_STAYS_IN_BROWSER);
    },
  );
});

describe('parseToolManifest: requires', () => {
  it('must be an array', () => {
    expect(only(mutate({ requires: 'wasm' }))).toMatchObject({
      path: 'requires',
      code: 'invalid-requires',
    });
  });

  it('names the entry that is not a capability', () => {
    expect(only(mutate({ requires: ['wasm', 'gpu'] }))).toMatchObject({
      path: 'requires[1]',
      code: 'unknown-capability',
    });
    expect(only(mutate({ requires: [1] })).message).toContain('number is not a capability');
  });

  it('rejects a capability listed twice', () => {
    expect(only(mutate({ requires: ['wasm', 'worker', 'wasm'] }))).toEqual({
      path: 'requires[2]',
      code: 'duplicate-capability',
      message: 'wasm is listed twice',
    });
  });
});

describe('parseToolManifest: budget', () => {
  it.each([null, 5, 'x', [], undefined])('must be an object (not %j)', (budget) => {
    expect(only(mutate({ budget })).message).toContain('must be an object');
  });

  it('accepts zero and exactly the limits', () => {
    expect(issuesOf(mutate({ budget: { scriptKb: 0, assetsKb: 0 } }))).toEqual([]);
    expect(issuesOf(mutate({ budget: { ...BUDGET_LIMITS } }))).toEqual([]);
  });

  it('rejects one KiB above each limit and below zero', () => {
    const script = only(mutate({ budget: { scriptKb: BUDGET_LIMITS.scriptKb + 1, assetsKb: 0 } }));
    expect(script.path).toBe('budget.scriptKb');
    const assets = only(mutate({ budget: { scriptKb: 0, assetsKb: BUDGET_LIMITS.assetsKb + 1 } }));
    expect(assets.path).toBe('budget.assetsKb');
    expect(only(mutate({ budget: { scriptKb: -1, assetsKb: 0 } })).path).toBe('budget.scriptKb');
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, '10', null])('rejects %j', (value) => {
    expect(only(mutate({ budget: { scriptKb: value, assetsKb: 0 } }))).toMatchObject({
      path: 'budget.scriptKb',
      code: 'invalid-budget',
    });
  });

  it('reports a missing and an unknown budget field', () => {
    const issues = issuesOf(mutate({ budget: { scriptKb: 1, size: 3 } }));
    expect(issues.map((issue) => issue.path)).toEqual(['budget.size', 'budget.assetsKb']);
  });
});

describe('parseToolManifest: load', () => {
  it.each([null, 'x', {}, undefined])('must be a function (not %j)', (load) => {
    expect(only(mutate({ load })).code).toBe('invalid-load');
  });
});

describe('parseToolManifest: properties', () => {
  const pick = <T>(next: () => number, items: readonly T[]): T =>
    items[Math.floor(next() * items.length)] as T;

  const junk = (next: () => number): unknown =>
    pick(next, [
      null,
      undefined,
      '',
      'x',
      'tool.pdf-merge.name',
      0,
      -1,
      1.5,
      Number.NaN,
      true,
      [],
      ['wasm'],
      {},
      { scriptKb: 1, assetsKb: 1 },
      () => Promise.resolve({}),
    ]);

  it('never throws and always agrees with itself, whatever it is given', () => {
    const next = random(20_261_119);
    const fields = Object.keys(validInput());
    let accepted = 0;
    let rejected = 0;
    for (let round = 0; round < 3000; round += 1) {
      const candidate: Record<string, unknown> = { ...validInput() };
      for (const field of fields) {
        const roll = next();
        if (roll < 0.2) {
          candidate[field] = junk(next);
        } else if (roll < 0.28) {
          Reflect.deleteProperty(candidate, field);
        }
      }
      if (next() < 0.1) {
        candidate[`extra${String(round)}`] = junk(next);
      }
      const result = parseToolManifest(candidate);
      if (result.ok) {
        accepted += 1;
        // Accepted: nothing unknown got through, and parsing the result again changes nothing.
        expect(Object.keys(result.value).toSorted()).toEqual(fields.toSorted());
        expect(parseToolManifest(result.value)).toEqual(result);
      } else {
        rejected += 1;
        expect(result.issues.length).toBeGreaterThan(0);
        for (const issue of result.issues) {
          expect(issue.message).not.toBe('');
        }
      }
    }
    // Both outcomes were exercised, so the run is not vacuous.
    expect(accepted).toBeGreaterThan(50);
    expect(rejected).toBeGreaterThan(50);
  });

  it('gives the same answer twice for the same input', () => {
    const input = mutate({ category: 'nope' });
    expect(parseToolManifest(input)).toEqual(parseToolManifest(input));
  });
});
