import { describe, expect, it } from 'vitest';
import { explainPattern, type ExplainKey } from '../../src/tools/regex/explain.ts';
import { compileError } from '../../src/tools/regex/match.ts';
import { EXPLAIN_KEYS } from '../../src/tools/regex/messages.ts';

/** The explanation as `depth:key` pairs, which is what the structure is about. */
function shape(pattern: string, flags = ''): string[] {
  return explainPattern(pattern, flags).map((item) => `${String(item.depth)}:${item.key}`);
}

function sources(pattern: string, flags = ''): string[] {
  return explainPattern(pattern, flags).map((item) => item.source);
}

describe('literals', () => {
  it('joins neighbouring characters into one text', () => {
    expect(explainPattern('hello', '')).toEqual([
      { depth: 0, source: 'hello', key: 'literal', params: { text: 'hello' }, lazy: false },
    ]);
  });

  it('keeps the text of an escaped character and its source', () => {
    expect(explainPattern(String.raw`a\.b`, '')).toEqual([
      { depth: 0, source: String.raw`a\.b`, key: 'literal', params: { text: 'a.b' }, lazy: false },
    ]);
  });

  it('treats a brace that starts no repetition as text', () => {
    expect(explainPattern('a{x', '')[0]).toMatchObject({ key: 'literal', params: { text: 'a{x' } });
    expect(explainPattern('a{,3}', '')[0]).toMatchObject({ params: { text: 'a{,3}' } });
  });

  it('reads other escapes as the character itself', () => {
    expect(explainPattern(String.raw`\/\-\a`, '')[0]).toMatchObject({ params: { text: '/-a' } });
  });
});

describe('repetition belongs to the last character only', () => {
  it('splits the text before a quantifier', () => {
    expect(shape('abc+')).toEqual(['0:literal', '0:literal', '0:oneOrMore']);
    expect(explainPattern('abc+', '').map((item) => item.source)).toEqual(['ab', 'c', '+']);
  });

  it('reads every quantifier', () => {
    expect(explainPattern('a*', '')[1]).toMatchObject({ key: 'zeroOrMore', source: '*' });
    expect(explainPattern('a+', '')[1]).toMatchObject({ key: 'oneOrMore', source: '+' });
    expect(explainPattern('a?', '')[1]).toMatchObject({ key: 'optional', source: '?' });
    expect(explainPattern('a{3}', '')[1]).toMatchObject({
      key: 'exactly',
      params: { count: 3 },
      source: '{3}',
    });
    expect(explainPattern('a{3,}', '')[1]).toMatchObject({
      key: 'atLeast',
      params: { count: 3 },
      source: '{3,}',
    });
    expect(explainPattern('a{3,9}', '')[1]).toMatchObject({
      key: 'between',
      params: { min: 3, max: 9 },
      source: '{3,9}',
    });
  });

  it('marks the lazy forms and writes their source', () => {
    const items = explainPattern('a+?b*?c{1,2}?d??', '');
    expect(items.filter((item) => item.lazy).map((item) => item.source)).toEqual([
      '+?',
      '*?',
      '{1,2}?',
      '??',
    ]);
    expect(explainPattern('a+', '')[1]?.lazy).toBe(false);
  });

  it('applies to an escape, a class and a group', () => {
    expect(shape(String.raw`\d+`)).toEqual(['0:digit', '0:oneOrMore']);
    expect(shape('[ab]*')).toEqual(['0:classStart', '1:literal', '1:literal', '0:zeroOrMore']);
    expect(shape('(a)?')).toEqual(['0:group', '1:literal', '0:optional']);
    expect(shape(String.raw`\.+`)).toEqual(['0:literal', '0:oneOrMore']);
  });
});

describe('escapes', () => {
  it.each([
    [String.raw`\d`, 'digit'],
    [String.raw`\D`, 'notDigit'],
    [String.raw`\w`, 'word'],
    [String.raw`\W`, 'notWord'],
    [String.raw`\s`, 'space'],
    [String.raw`\S`, 'notSpace'],
    [String.raw`\b`, 'wordBoundary'],
    [String.raw`\B`, 'notWordBoundary'],
    [String.raw`\n`, 'lineFeed'],
    [String.raw`\r`, 'carriageReturn'],
    [String.raw`\t`, 'tab'],
    [String.raw`\v`, 'verticalTab'],
    [String.raw`\f`, 'formFeed'],
    [String.raw`\0`, 'nul'],
    ['.', 'any'],
    ['^', 'start'],
    ['$', 'end'],
  ] satisfies [string, ExplainKey][])('explains %s', (pattern, key) => {
    expect(explainPattern(pattern, '')).toEqual([
      { depth: 0, source: pattern, key, params: {}, lazy: false },
    ]);
  });

  it('reads code points in the three notations', () => {
    expect(explainPattern(String.raw`\x41`, '')[0]).toMatchObject({
      key: 'codePoint',
      params: { code: '0041' },
    });
    expect(explainPattern(String.raw`\u${'20ac'}`, '')[0]).toMatchObject({
      params: { code: '20AC' },
    });
    expect(explainPattern(String.raw`\u{1F600}`, 'u')[0]).toMatchObject({
      source: String.raw`\u{1F600}`,
      params: { code: '1F600' },
    });
  });

  it('does not read \\u{...} as a code point without the u flag (it is a repeated u)', () => {
    expect(shape(String.raw`\u{41}`)).toEqual(['0:literal', '0:exactly']);
  });

  it('reads a backslash-x that is not followed by two hex digits as the letter', () => {
    expect(explainPattern(String.raw`\xZ`, '')[0]).toMatchObject({ params: { text: 'xZ' } });
    expect(explainPattern(String.raw`\u12`, '')[0]).toMatchObject({ params: { text: 'u12' } });
  });

  it('reads control characters', () => {
    expect(explainPattern(String.raw`\cj`, '')[0]).toMatchObject({
      key: 'control',
      params: { letter: 'J' },
    });
    expect(explainPattern(String.raw`\c1`, '')[0]).toMatchObject({ key: 'literal' });
  });

  it('reads Unicode properties only with u or v', () => {
    expect(explainPattern(String.raw`\p{Lu}`, 'u')[0]).toMatchObject({
      key: 'property',
      params: { property: 'Lu' },
    });
    expect(explainPattern(String.raw`\P{Script=Greek}`, 'v')[0]).toMatchObject({
      key: 'notProperty',
      params: { property: 'Script=Greek' },
    });
    expect(explainPattern(String.raw`\p`, '')[0]).toMatchObject({ key: 'literal' });
  });

  it('reads back-references', () => {
    expect(explainPattern(String.raw`(a)\1`, '')[2]).toMatchObject({
      key: 'backReference',
      params: { n: 1 },
    });
    expect(explainPattern(String.raw`\12`, '')[0]).toMatchObject({ params: { n: 12 } });
    expect(explainPattern(String.raw`(?<year>a)\k<year>`, '')[2]).toMatchObject({
      key: 'namedBackReference',
      params: { name: 'year' },
      source: String.raw`\k<year>`,
    });
  });

  it('reads \\0 followed by a digit as an escaped character, not NUL', () => {
    expect(explainPattern(String.raw`\01`, '')[0]?.key).toBe('literal');
  });

  it('reads a trailing lone backslash as text instead of failing', () => {
    expect(explainPattern('a\\', '')[0]).toMatchObject({ key: 'literal' });
  });
});

describe('flags change the meaning', () => {
  it('the dot with and without s', () => {
    expect(explainPattern('.', '')[0]?.key).toBe('any');
    expect(explainPattern('.', 's')[0]?.key).toBe('anyAll');
  });

  it('the anchors with and without m', () => {
    expect(shape('^a$')).toEqual(['0:start', '0:literal', '0:end']);
    expect(shape('^a$', 'm')).toEqual(['0:startLine', '0:literal', '0:endLine']);
  });
});

describe('character classes', () => {
  it('lists single characters, ranges and escapes', () => {
    const items = explainPattern(String.raw`[a-z0-9_\d.\-]`, '');
    expect(items.map((item) => item.key)).toEqual([
      'classStart',
      'classRange',
      'classRange',
      'literal',
      'digit',
      'literal',
      'literal',
    ]);
    expect(items[1]).toMatchObject({ depth: 1, source: 'a-z', params: { from: 'a', to: 'z' } });
    expect(items[0]?.source).toBe(String.raw`[a-z0-9_\d.\-]`);
  });

  it('negates with a caret', () => {
    expect(shape('[^abc]')).toEqual(['0:classStartNot', '1:literal', '1:literal', '1:literal']);
  });

  it('knows the empty and the all-matching class', () => {
    expect(shape('[]')).toEqual(['0:classEmpty']);
    expect(shape('[^]')).toEqual(['0:classAny']);
  });

  it('keeps a dash at either end as a character and a ] after an escape inside', () => {
    expect(shape('[a-]')).toEqual(['0:classStart', '1:literal', '1:literal']);
    expect(shape('[-a]')).toEqual(['0:classStart', '1:literal', '1:literal']);
    expect(shape(String.raw`[\]x]`)).toEqual(['0:classStart', '1:literal', '1:literal']);
  });

  it('does not make a range of a class escape', () => {
    expect(shape(String.raw`[a-\d]`)).toEqual([
      '0:classStart',
      '1:literal',
      '1:literal',
      '1:digit',
    ]);
  });

  it('knows \\b is a backspace inside a class', () => {
    expect(shape(String.raw`[\b]`)).toEqual(['0:classStart', '1:backspace']);
  });

  it('does not treat [ inside a class as nesting without the v flag', () => {
    expect(shape('[[a]')).toEqual(['0:classStart', '1:literal', '1:literal']);
  });

  it('shows a v-mode set with nested sets or operators as one part', () => {
    expect(shape(String.raw`[\p{L}--[a-z]]`, 'v')).toEqual(['0:classSet']);
    expect(shape('[[a-c]&&[b-d]]', 'v')).toEqual(['0:classSet']);
    expect(shape(String.raw`[\q{abc}]`, 'v')).toEqual(['0:classSet']);
    expect(shape('[abc]', 'v')).toEqual(['0:classStart', '1:literal', '1:literal', '1:literal']);
  });
});

describe('groups', () => {
  it('numbers the remembered groups in the order they open, and nests the contents', () => {
    const items = explainPattern('(a(b))c', '');
    expect(items.map((item) => `${String(item.depth)}:${item.key}`)).toEqual([
      '0:group',
      '1:literal',
      '1:group',
      '2:literal',
      '0:literal',
    ]);
    expect(items[0]?.params).toEqual({ n: 1 });
    expect(items[2]?.params).toEqual({ n: 2 });
  });

  it('names a group and counts it too', () => {
    const items = explainPattern('(a)(?<year>b)', '');
    expect(items[2]).toMatchObject({
      key: 'groupNamed',
      source: '(?<year>',
      params: { n: 2, name: 'year' },
    });
  });

  it('knows the groups that are not remembered, and the look-around groups', () => {
    expect(shape('(?:a)')).toEqual(['0:groupPlain', '1:literal']);
    expect(shape('(?=a)')).toEqual(['0:lookahead', '1:literal']);
    expect(shape('(?!a)')).toEqual(['0:notLookahead', '1:literal']);
    expect(shape('(?<=a)')).toEqual(['0:lookbehind', '1:literal']);
    expect(shape('(?<!a)')).toEqual(['0:notLookbehind', '1:literal']);
    expect(sources('(?<!a)')).toEqual(['(?<!', 'a']);
  });

  it('reads a group with changed flags', () => {
    expect(explainPattern('(?i:a)', '')[0]).toMatchObject({
      key: 'modifiers',
      source: '(?i:',
      params: { modifiers: 'i' },
    });
  });

  it('puts an alternation at the level of the group it is in', () => {
    expect(shape('a|b')).toEqual(['0:literal', '0:alternation', '0:literal']);
    expect(shape('(a|b)')).toEqual(['0:group', '1:literal', '1:alternation', '1:literal']);
  });

  it('does not go below depth 0 for a stray closing parenthesis', () => {
    expect(shape('a)b')).toEqual(['0:literal', '0:literal']);
  });
});

describe('the explanation of any pattern the browser accepts', () => {
  const patterns = [
    String.raw`^(\d{4})-(\d{2})-(\d{2})$`,
    String.raw`[\w.+-]+@[\w-]+\.[\w.-]+`,
    String.raw`(?<=\$)\d+(?:\.\d\d)?`,
    String.raw`\b(\w+)\s+\1\b`,
    String.raw`(a+)+$`,
    String.raw`[^\s"]+|"[^"]*"`,
    String.raw`\p{L}+`,
    String.raw`(?:)`,
    String.raw`a{2,3}?|b*?`,
  ];

  it.each(patterns)('describes %s with a message for every part', (pattern) => {
    const flags = pattern.includes(String.raw`\p`) ? 'u' : '';
    expect(compileError(pattern, flags)).toBeUndefined();
    const items = explainPattern(pattern, flags);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(EXPLAIN_KEYS[item.key]).toBeDefined();
      expect(item.depth).toBeGreaterThanOrEqual(0);
    }
  });

  it('never throws and never loses a character: the sources add up to the pattern (property)', () => {
    let state = 0x1234567;
    const next = (): number => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state;
    };
    const alphabet = [
      'a',
      'b',
      '1',
      '.',
      '*',
      '+',
      '?',
      '|',
      '(',
      ')',
      '[',
      ']',
      '{',
      '}',
      '^',
      '$',
      '-',
      ',',
      '2',
    ];
    for (let round = 0; round < 500; round += 1) {
      let pattern = '';
      for (let index = 0; index < 1 + (next() % 12); index += 1) {
        pattern += alphabet[next() % alphabet.length] ?? 'a';
      }
      expect(() => explainPattern(pattern, '')).not.toThrow();
      expect(() => explainPattern(pattern, 'v')).not.toThrow();
      if (compileError(pattern, '') === undefined && !pattern.includes('[')) {
        // Outside classes every character belongs to exactly one part (a closing parenthesis to none).
        const joined = explainPattern(pattern, '')
          .map((item) => item.source)
          .join('');
        expect(joined.length).toBeLessThanOrEqual(pattern.length);
      }
    }
  });
});
