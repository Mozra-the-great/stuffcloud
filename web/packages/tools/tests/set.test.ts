import { describe, expect, it } from 'vitest';
import { parseToolSet, parseToolsConfig, TOOL_CATEGORIES } from '../src/index.ts';
import { mutate, random, validInput } from './fixtures.ts';

function tool(id: string, category: string): Record<string, unknown> {
  return mutate({ id, category }, id);
}

describe('parseToolSet', () => {
  it('sorts by category order, then id, whatever order the files came in', () => {
    const result = parseToolSet(
      [tool('zip', 'extra'), tool('b-pdf', 'pdf'), tool('a-img', 'image'), tool('a-pdf', 'pdf')],
      TOOL_CATEGORIES,
    );
    expect(result.ok && result.manifests.map((manifest) => manifest.id)).toEqual([
      'a-pdf',
      'b-pdf',
      'a-img',
      'zip',
    ]);
  });

  it('accepts an empty set', () => {
    expect(parseToolSet([], TOOL_CATEGORIES)).toEqual({ ok: true, manifests: [] });
  });

  it('puts the tool id in front of the path of every issue', () => {
    const result = parseToolSet([tool('good', 'pdf'), tool('bad', 'nope')], TOOL_CATEGORIES);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.map((issue) => issue.path)).toEqual(['bad.category']);
  });

  it('uses the position when a manifest has no usable id', () => {
    const result = parseToolSet([null, { id: '' }, { id: 5 }], TOOL_CATEGORIES);
    const paths = !result.ok ? result.issues.map((issue) => issue.path) : [];
    expect(paths[0]).toBe('#0');
    expect(paths.filter((path) => path.startsWith('#1.')).length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.startsWith('#2.')).length).toBeGreaterThan(0);
  });

  it('rejects a duplicate id and names the first user', () => {
    const result = parseToolSet(
      [tool('same', 'pdf'), tool('other', 'pdf'), tool('same', 'image')],
      TOOL_CATEGORIES,
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          path: 'same',
          code: 'duplicate-id',
          message: 'id "same" is already used by the tool at position 0',
        },
      ],
    });
  });

  it('hands the options on to every manifest', () => {
    const server = mutate({ runsIn: 'server' });
    expect(parseToolSet([server], TOOL_CATEGORIES).ok).toBe(false);
    expect(parseToolSet([server], TOOL_CATEGORIES, { allowServer: true }).ok).toBe(true);
  });

  it('returns the same set in any input order (property)', () => {
    const next = random(7);
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const expected = parseToolSet(
      ids.map((id, index) => tool(id, TOOL_CATEGORIES[index % TOOL_CATEGORIES.length] ?? 'pdf')),
      TOOL_CATEGORIES,
    );
    for (let round = 0; round < 200; round += 1) {
      const shuffled = ids
        .map((id, index) => ({ id, index, key: next() }))
        .toSorted((x, y) => x.key - y.key)
        .map(({ id, index }) => tool(id, TOOL_CATEGORIES[index % TOOL_CATEGORIES.length] ?? 'pdf'));
      const result = parseToolSet(shuffled, TOOL_CATEGORIES);
      expect(result.ok && result.manifests.map((m) => m.id)).toEqual(
        expected.ok ? expected.manifests.map((m) => m.id) : [],
      );
    }
  });

  it('keeps validInput usable as a single-element set', () => {
    expect(parseToolSet([validInput()], TOOL_CATEGORIES).ok).toBe(true);
  });
});

describe('parseToolsConfig', () => {
  const known = new Set(['merge-pdf', 'qr']);

  it('accepts an empty list and known ids', () => {
    expect(parseToolsConfig({ disabled: [] }, known)).toEqual({
      ok: true,
      value: { disabled: [] },
    });
    expect(parseToolsConfig({ disabled: ['qr', 'merge-pdf'] }, known)).toEqual({
      ok: true,
      value: { disabled: ['qr', 'merge-pdf'] },
    });
  });

  it.each([null, 'x', 3, [], undefined])('rejects %j as a whole', (input) => {
    expect(parseToolsConfig(input, known)).toEqual({
      ok: false,
      issues: ['the configuration must be an object { "disabled": [...] }'],
    });
  });

  it('requires the disabled list', () => {
    expect(parseToolsConfig({}, known)).toEqual({
      ok: false,
      issues: ['disabled: must be an array of tool ids'],
    });
    expect(parseToolsConfig({ disabled: 'qr' }, known)).toEqual({
      ok: false,
      issues: ['disabled: must be an array of tool ids'],
    });
  });

  it('rejects a field it does not know', () => {
    expect(parseToolsConfig({ disabled: [], disable: [] }, known)).toEqual({
      ok: false,
      issues: ['disable: is not a configuration field (disabled)'],
    });
  });

  it('rejects an id that is malformed, not a string, unknown or listed twice', () => {
    const result = parseToolsConfig({ disabled: ['Bad Id', 7, 'ghost', 'qr', 'qr'] }, known);
    expect(result).toEqual({
      ok: false,
      issues: [
        'disabled[0]: must be a valid tool id',
        'disabled[1]: must be a valid tool id',
        'disabled[2]: there is no tool "ghost"',
        'disabled[4]: "qr" is listed twice',
      ],
    });
  });

  it('does not take an inherited field for the list', () => {
    const inherited = Object.create({ disabled: ['qr'] }) as Record<string, unknown>;
    expect(parseToolsConfig(inherited, known).ok).toBe(false);
  });
});
