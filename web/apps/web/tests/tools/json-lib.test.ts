import { describe, expect, it } from 'vitest';
import {
  MAX_DEPTH,
  describeChar,
  formatJson,
  formatPath,
  locate,
  losesPrecision,
  parseJson,
  parsePath,
  pathAt,
  statsOf,
  toValue,
  valueAt,
  type JsonError,
  type JsonFeature,
  type JsonNode,
} from '../../src/tools/json-formatter/json.ts';

function node(text: string, strict = false): JsonNode {
  const result = parseJson(text, { strict });
  if (!result.ok) {
    throw new Error(`not parsed: ${JSON.stringify(result.error)}`);
  }
  return result.node;
}

function error(text: string, strict = false): JsonError {
  const result = parseJson(text, { strict });
  if (result.ok) {
    throw new Error('parsed without an error');
  }
  return result.error;
}

function features(text: string): readonly JsonFeature[] {
  const result = parseJson(text, { strict: false });
  if (!result.ok) {
    throw new Error('not parsed');
  }
  return result.features;
}

const pretty = { indent: 2, sortKeys: false } as const;
const compact = { indent: 0, sortKeys: false } as const;

describe('locate', () => {
  it('counts lines and columns from 1, over every kind of line break', () => {
    expect(locate('abc', 0)).toEqual({ line: 1, column: 1 });
    expect(locate('abc', 2)).toEqual({ line: 1, column: 3 });
    expect(locate('a\nbc', 3)).toEqual({ line: 2, column: 2 });
    expect(locate('a\r\nbc', 4)).toEqual({ line: 2, column: 2 });
    expect(locate('a\rbc', 3)).toEqual({ line: 2, column: 2 });
    expect(locate('a\n\nb', 3)).toEqual({ line: 3, column: 1 });
    expect(locate('ab', 2)).toEqual({ line: 1, column: 3 });
  });
});

describe('describeChar', () => {
  it('shows a control character as its code point and everything else as itself', () => {
    expect(describeChar('\n')).toBe('U+000A');
    expect(describeChar('\u007f')).toBe('U+007F');
    expect(describeChar('\u2028')).toBe('U+2028');
    expect(describeChar('}')).toBe('}');
    expect(describeChar(' ')).toBe(' ');
    expect(describeChar('')).toBe('U+0000');
  });
});

describe('parseJson: valid documents', () => {
  it.each([
    'null',
    'true',
    'false',
    '0',
    '-0',
    '1.5e10',
    '1E-2',
    '"a"',
    '""',
    '[]',
    '{}',
    '[1,2,3]',
    '{"a":{"b":[null,true,false,"x",1.5]}}',
    ' \n\t[ 1 , 2 ]\r\n',
    '"\\u00e9\\n\\t\\"\\\\\\/\\b\\f\\r"',
  ])('reads %j exactly as JSON.parse does', (text) => {
    const result = parseJson(text, { strict: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.features).toEqual([]);
      expect(toValue(result.node)).toEqual(JSON.parse(text));
    }
  });

  it('ignores a byte order mark in front of the document', () => {
    expect(toValue(node('\ufeff{"a":1}', true))).toEqual({ a: 1 });
  });

  it('keeps the number as written, so no digit is lost', () => {
    const root = node('[12345678901234567890, 1e400, 0.10]');
    expect(formatJson(root, compact)).toBe('[12345678901234567890,1e400,0.10]');
  });

  it('keeps __proto__ as a key without touching the prototype', () => {
    const value = toValue(node('{"__proto__": {"polluted": true}, "a": 1}')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(value)).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('lets the last duplicate key win, like JSON.parse', () => {
    expect(toValue(node('{"a":1,"a":2}'))).toEqual({ a: 2 });
  });

  it('reads a document nested as deep as allowed, and not one level deeper', () => {
    const at = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;
    expect(parseJson(at(MAX_DEPTH), { strict: true }).ok).toBe(true);
    const deep = error(at(MAX_DEPTH + 1));
    expect(deep.code).toBe('tooDeep');
    expect(deep.offset).toBe(MAX_DEPTH);
    const deepObject = `${'{"a":'.repeat(MAX_DEPTH + 1)}1${'}'.repeat(MAX_DEPTH + 1)}`;
    expect(error(deepObject).code).toBe('tooDeep');
  });
});

describe('parseJson: JSON5 and comments', () => {
  it('reads comments and says so', () => {
    const text = '// first\n{\n  /* inside */ "a": 1 // after\n}';
    expect(toValue(node(text))).toEqual({ a: 1 });
    expect(features(text)).toEqual(['comment']);
  });

  it('reads trailing commas in objects and arrays', () => {
    expect(toValue(node('{"a":[1,2,],}'))).toEqual({ a: [1, 2] });
    expect(features('[1,]')).toEqual(['trailingComma']);
  });

  it('reads single quotes, unquoted keys and their escapes', () => {
    expect(toValue(node("{a: 'it\\'s', $b_1: \"x\", é: 1}"))).toEqual({
      a: "it's",
      $b_1: 'x',
      é: 1,
    });
    expect(features("{'a': 1}")).toEqual(['singleQuote']);
    expect(features('{a: 1}')).toEqual(['unquotedKey']);
  });

  it.each([
    ['+1', '1'],
    ['.5', '0.5'],
    ['-.5', '-0.5'],
    ['5.', '5'],
    ['5.e3', '5e3'],
    ['0x1F', '31'],
    ['-0xff', '-255'],
    ['-0x0', '0'],
    ['+0.5e+2', '0.5e+2'],
  ])('writes the JSON5 number %s as %s', (source, written) => {
    const root = node(source);
    expect(formatJson(root, pretty)).toBe(written);
    expect(features(source)).toEqual(['number']);
  });

  it.each([
    ['"\\x41\\v\\0"', 'A\v\0'],
    ['"a\\\nb"', 'ab'],
    ['"a\\\r\nb"', 'ab'],
    ['"a\\\rb"', 'ab'],
    ['"a\\\u2028b"', 'ab'],
    ['"tab\there"', 'tab\there'],
  ])('reads the JSON5 string %j', (source, value) => {
    expect(toValue(node(source))).toBe(value);
    expect(features(source)).toEqual(['stringSyntax']);
  });

  it('accepts the unusual white space of JSON5', () => {
    expect(toValue(node('[1,\u00a02,\u000b3]'))).toEqual([1, 2, 3]);
    expect(features('[1,\u00a02]')).toEqual(['whitespace']);
  });

  it('lists every feature once, in a fixed order', () => {
    expect(features("// c\n{a: 'x', b: +1, c: [1,],}")).toEqual([
      'comment',
      'trailingComma',
      'singleQuote',
      'unquotedKey',
      'number',
    ]);
  });
});

describe('parseJson: strict mode refuses what JSON5 adds', () => {
  it.each<[string, JsonFeature, number]>([
    ['// c\n1', 'comment', 0],
    ['/* c */ 1', 'comment', 0],
    ['[1,]', 'trailingComma', 2],
    ['{"a":1,}', 'trailingComma', 6],
    ["'a'", 'singleQuote', 0],
    ['{a:1}', 'unquotedKey', 1],
    ['+1', 'number', 0],
    ['.5', 'number', 0],
    ['0x10', 'number', 0],
    ['"\\x41"', 'stringSyntax', 1],
    ['\u00a01', 'whitespace', 0],
  ])('%j uses a %s at offset %i', (text, feature, offset) => {
    const problem = error(text, true);
    expect(problem.code).toBe('feature');
    expect(problem.feature).toBe(feature);
    expect(problem.offset).toBe(offset);
  });

  it('reports a raw tab in a string as a control character', () => {
    expect(error('"a\tb"', true)).toMatchObject({ code: 'controlChar', found: 'U+0009' });
  });
});

describe('parseJson: errors with a position', () => {
  it('says what was expected and what was found, with line and column', () => {
    const problem = error('{\n  "a": 1\n  "b": 2\n}');
    expect(problem).toMatchObject({
      code: 'unexpectedChar',
      found: '"',
      expected: 'commaOrBrace',
      line: 3,
      column: 3,
    });
  });

  it.each<[string, string, JsonError['expected'], string | undefined]>([
    ['', 'empty', undefined, undefined],
    ['   \n ', 'empty', undefined, undefined],
    ['// only a comment', 'empty', undefined, undefined],
    ['[1, 2', 'unexpectedEnd', 'commaOrBracket', undefined],
    ['[', 'unexpectedEnd', 'value', undefined],
    ['{', 'unexpectedEnd', 'keyOrBrace', undefined],
    ['{"a"', 'unexpectedEnd', 'colon', undefined],
    ['{"a":', 'unexpectedEnd', 'value', undefined],
    ['{"a":1', 'unexpectedEnd', 'commaOrBrace', undefined],
    ['{"a":1,', 'unexpectedEnd', 'key', undefined],
    ['{"a" 1}', 'unexpectedChar', 'colon', '1'],
    ['{1: 2}', 'unexpectedChar', 'keyOrBrace', '1'],
    ['{"a":1,2}', 'unexpectedChar', 'key', '2'],
    ['[1 2]', 'unexpectedChar', 'commaOrBracket', '2'],
    ['[1]]', 'unexpectedChar', 'end', ']'],
    ['1 2', 'unexpectedChar', 'end', '2'],
    ['[,]', 'unexpectedChar', 'value', ','],
    ['}', 'unexpectedChar', 'value', '}'],
    ['tru', 'unexpectedChar', 'value', 'tru'],
    ['nul', 'unexpectedChar', 'value', 'nul'],
    ['undefined', 'unexpectedChar', 'value', 'undefined'],
    ['{"a":\u0001}', 'unexpectedChar', 'value', 'U+0001'],
  ])('%j: %s (%s, found %s)', (text, code, expected, found) => {
    const problem = error(text);
    expect(problem.code).toBe(code);
    expect(problem.expected).toBe(expected);
    expect(problem.found).toBe(found);
  });

  it('shortens a very long word', () => {
    expect(error(`a${'b'.repeat(100)}`).found).toHaveLength(24);
  });

  it('points at the character that is wrong', () => {
    expect(error('[1, 2,, 3]')).toMatchObject({ offset: 6, line: 1, column: 7 });
    expect(error('{"a": 1,\n"b": }')).toMatchObject({ code: 'unexpectedChar', line: 2, column: 6 });
  });

  it.each(['01', '1e', '--1', '1-2', '-', '.', '+', '.e5', '0xZZ'])(
    'refuses the number %s as written',
    (text) => {
      const problem = error(text);
      expect(problem.code).toBe('badNumber');
      expect(problem.found).toBe(text);
    },
  );

  it('stops a number at a character that cannot be part of it', () => {
    expect(error('1_000')).toMatchObject({
      code: 'unexpectedChar',
      expected: 'end',
      found: '_000',
    });
  });

  it('shortens a number that is too long to show whole', () => {
    expect(error(`1${'x'.repeat(40)}`).found).toHaveLength(24);
  });

  it('says that NaN and Infinity cannot be written in JSON', () => {
    for (const text of ['NaN', 'Infinity', '-Infinity', '+Infinity', '-NaN']) {
      expect(error(text).code).toBe('notRepresentable');
    }
    expect(error('[NaN]').offset).toBe(1);
  });

  it('refuses NaN and Infinity in strict mode like any unknown word', () => {
    expect(error('NaN', true).code).toBe('unexpectedChar');
    expect(error('-Infinity', true).code).toBe('badNumber');
  });

  it('reports the string problems at the right place', () => {
    expect(error('"abc')).toMatchObject({ code: 'unterminatedString', offset: 0 });
    expect(error('["abc')).toMatchObject({ code: 'unterminatedString', offset: 1 });
    expect(error('"abc\ndef"')).toMatchObject({ code: 'controlChar', found: 'U+000A', offset: 4 });
    expect(error('"a\u0000b"', true)).toMatchObject({ code: 'controlChar', found: 'U+0000' });
    expect(error('"a\\')).toMatchObject({ code: 'unterminatedString' });
    expect(error('"\\q"')).toMatchObject({ code: 'badEscape', found: '\\q', offset: 1 });
    expect(error('"\\u12G4"')).toMatchObject({ code: 'badUnicode', offset: 1 });
    expect(error('"\\u12"')).toMatchObject({ code: 'badUnicode' });
    expect(error('"\\xZ1"')).toMatchObject({ code: 'badUnicode' });
    expect(error('"\\01"')).toMatchObject({ code: 'badEscape' });
  });

  it('reports an unterminated comment where it starts', () => {
    expect(error('[1, /* never closed')).toMatchObject({ code: 'unterminatedComment', offset: 4 });
  });

  it('reads a raw line separator inside a string, which JSON allows', () => {
    expect(toValue(node('"a\u2028b"', true))).toBe('a\u2028b');
  });

  it('reads 1. as the JSON5 number 1', () => {
    expect(formatJson(node('1.'), pretty)).toBe('1');
  });

  it('keeps a lone surrogate escape as it is', () => {
    expect(toValue(node('"\\ud800"'))).toBe('\ud800');
    expect(formatJson(node('"\\ud800"'), pretty)).toBe('"\\ud800"');
  });
});

describe('formatJson', () => {
  const document = '{"b":[1,{"z":null,"a":true}],"a":"x","empty":{},"list":[]}';

  it('indents with two or four spaces or a tab', () => {
    const root = node(document);
    expect(formatJson(root, pretty)).toBe(JSON.stringify(JSON.parse(document), null, 2));
    expect(formatJson(root, { indent: 4, sortKeys: false })).toBe(
      JSON.stringify(JSON.parse(document), null, 4),
    );
    expect(formatJson(root, { indent: 'tab', sortKeys: false })).toBe(
      JSON.stringify(JSON.parse(document), null, '\t'),
    );
  });

  it('minifies to one line', () => {
    expect(formatJson(node(' { "a" : [ 1 , 2 ] , "b" : { } } '), compact)).toBe(
      '{"a":[1,2],"b":{}}',
    );
  });

  it('sorts the keys of every object and leaves arrays alone', () => {
    expect(formatJson(node(document), { indent: 0, sortKeys: true })).toBe(
      '{"a":"x","b":[1,{"a":true,"z":null}],"empty":{},"list":[]}',
    );
  });

  it('sorts by code unit and keeps duplicate keys in their order', () => {
    expect(formatJson(node('{"b":1,"B":2,"a":3,"a":4}'), { indent: 0, sortKeys: true })).toBe(
      '{"B":2,"a":3,"a":4,"b":1}',
    );
  });

  it('writes comments and JSON5 as strict JSON', () => {
    expect(formatJson(node("{a: 'x', // c\n b: [1,],}"), compact)).toBe('{"a":"x","b":[1]}');
  });

  it('gives a text that reads back to the same value', () => {
    const text = '{"k":"\\u2028 \\" é 😀","n":[1e2,-0,0.5],"t":[true,false,null]}';
    const written = formatJson(node(text), pretty);
    expect(toValue(node(written, true))).toEqual(JSON.parse(text));
  });
});

describe('losesPrecision and statsOf', () => {
  it('knows which integers a number cannot hold', () => {
    expect(losesPrecision('9007199254740991')).toBe(false);
    expect(losesPrecision('9007199254740993')).toBe(true);
    expect(losesPrecision('-9007199254740993')).toBe(true);
    expect(losesPrecision('9007199254740992')).toBe(false);
    expect(losesPrecision('1.5')).toBe(false);
    expect(losesPrecision('1e400')).toBe(false);
    expect(losesPrecision('12345678901234567890')).toBe(true);
    // Too large for any JavaScript number: it has to answer, not throw.
    expect(losesPrecision('1'.padEnd(400, '0'))).toBe(true);
    expect(losesPrecision('-'.concat('9'.repeat(309)))).toBe(true);
  });

  it('counts the values, keys and depth', () => {
    const stats = statsOf(node('{"a":[1,"x",null,true,{"b":12345678901234567891}],"a":2,"c":{}}'));
    expect(stats).toEqual({
      depth: 4,
      objects: 3,
      arrays: 1,
      strings: 1,
      numbers: 3,
      booleans: 1,
      nulls: 1,
      keys: 4,
      duplicateKeys: 1,
      bigNumbers: 1,
    });
    expect(statsOf(node('1')).depth).toBe(1);
  });
});

describe('paths', () => {
  const text = '{\n  "a": [10, {"b c": true}],\n  "d": null\n}';
  const root = node(text);

  it('writes a path like JSONPath', () => {
    expect(formatPath([])).toBe('$');
    expect(formatPath(['a', 0, 'b c', 'd_$1'])).toBe('$.a[0]["b c"].d_$1');
    expect(formatPath(['1a', 'a"b'])).toBe('$["1a"]["a\\"b"]');
  });

  it.each([
    ['{', []],
    ['"a"', ['a']],
    ['10', ['a', 0]],
    ['true', ['a', 1, 'b c']],
    ['"b c"', ['a', 1, 'b c']],
    ['null', ['d']],
  ])('finds the path of the cursor inside %s', (needle, expected) => {
    expect(pathAt(root, text.indexOf(needle) + (needle.length > 1 ? 1 : 0))).toEqual(expected);
  });

  it('answers with the enclosing value between two values and outside the document', () => {
    expect(pathAt(root, text.indexOf(',') + 1)).toEqual(['a']);
    expect(pathAt(root, text.indexOf('"d"') - 2)).toEqual([]);
    expect(pathAt(root, 10_000)).toEqual([]);
    expect(pathAt(node('[]'), 1)).toEqual([]);
    expect(pathAt(node('[ ]'), 1)).toEqual([]);
  });

  it('puts a key and its colon on the member', () => {
    expect(pathAt(node('{"a" : 1}'), 4)).toEqual(['a']);
    expect(pathAt(node('{"a" : 1}'), 6)).toEqual(['a']);
  });

  it.each([
    ['', []],
    ['$', []],
    ['$.a', ['a']],
    ['a', ['a']],
    ['a.b', ['a', 'b']],
    ['$.a[0].b', ['a', 0, 'b']],
    ['$["b c"]', ['b c']],
    ["$['b c'][1]", ['b c', 1]],
    ['$[0]', [0]],
    ['[0][1]', [0, 1]],
    ['a.0', ['a', 0]],
    ['  $.a  ', ['a']],
    ['$["a\\"b"]', ['a"b']],
    ['$["a\\nb\\tc"]', ['a\nb\tc']],
  ])('reads the path %j', (source, expected) => {
    expect(parsePath(source)).toEqual({ ok: true, segments: expected });
  });

  it.each([
    ['$.', 2],
    ['$..a', 2],
    ['$[', 2],
    ['$[a]', 2],
    ['$[1', 2],
    ['$["a"', 2],
    ['$["a', 2],
    ['$["a\\', 2],
    ['$["a"x]', 2],
    ['$ a', 1],
    ['$.1a', 2],
    ['$a', 1],
    ['a b', 1],
    ['$]', 1],
  ])('refuses the path %j at %i', (source, offset) => {
    expect(parsePath(source)).toEqual({ ok: false, offset });
  });

  it('finds the value at a path', () => {
    expect(valueAt(root, [])).toBe(root);
    expect(valueAt(root, ['a', 1, 'b c'])?.kind).toBe('boolean');
    expect(valueAt(root, ['a', 0])).toMatchObject({ kind: 'number', raw: '10' });
    expect(valueAt(root, ['d'])?.kind).toBe('null');
  });

  it('finds nothing where the document has nothing', () => {
    expect(valueAt(root, ['x'])).toBeUndefined();
    expect(valueAt(root, ['a', 5])).toBeUndefined();
    expect(valueAt(root, [0])).toBeUndefined();
    expect(valueAt(root, ['a', 'b'])).toBeUndefined();
    expect(valueAt(root, ['d', 'x'])).toBeUndefined();
    expect(valueAt(root, ['x', 'y', 'z'])).toBeUndefined();
  });

  it('takes the last of two equal keys, like JSON.parse', () => {
    expect(valueAt(node('{"a":1,"a":2}'), ['a'])).toMatchObject({ raw: '2' });
  });
});

/** A small deterministic generator (no extra dependency): the same seed gives the same values. */
function random(seed: number): () => number {
  let state = seed;
  return (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function generate(next: () => number, depth: number): unknown {
  const kind = Math.floor(next() * (depth > 3 ? 5 : 7));
  switch (kind) {
    case 0:
      return null;
    case 1:
      return next() < 0.5;
    case 2:
      return Math.round((next() - 0.5) * 1e6) / (next() < 0.5 ? 1 : 1000);
    case 3:
    case 4:
      return Array.from({ length: Math.floor(next() * 6) }, () =>
        String.fromCodePoint(Math.floor(next() * 0x2fff) + (next() < 0.2 ? 0 : 0x20)),
      ).join('');
    case 5:
      return Array.from({ length: Math.floor(next() * 5) }, () => generate(next, depth + 1));
    default:
      return Object.fromEntries(
        Array.from({ length: Math.floor(next() * 5) }, () => [
          `k${String(Math.floor(next() * 9))}${next() < 0.3 ? ' "é' : ''}`,
          generate(next, depth + 1),
        ]),
      );
  }
}

describe('property: the reader and the writer agree with JSON', () => {
  it('formats any generated document like JSON.stringify, strictly, and reads it back', () => {
    const next = random(20261119);
    for (let round = 0; round < 400; round += 1) {
      const value = generate(next, 0);
      const source = JSON.stringify(value);
      for (const indent of [0, 2, 4] as const) {
        const root = node(source, true);
        expect(formatJson(root, { indent, sortKeys: false })).toBe(
          indent === 0 ? source : JSON.stringify(value, null, indent),
        );
      }
      expect(toValue(node(source, true))).toEqual(JSON.parse(source));
      // Writing is idempotent.
      const once = formatJson(node(source, true), pretty);
      expect(formatJson(node(once, true), pretty)).toBe(once);
    }
  });

  it('never throws on damaged input, and every error points inside the text', () => {
    const next = random(7);
    for (let round = 0; round < 600; round += 1) {
      const source = JSON.stringify(generate(next, 0));
      const cut = Math.floor(next() * (source.length + 1));
      const damaged =
        next() < 0.5
          ? source.slice(0, cut)
          : `${source.slice(0, cut)}${'{}[],:"*x1-/'.charAt(Math.floor(next() * 13))}${source.slice(cut)}`;
      // In strict mode the reader accepts exactly what JSON.parse accepts.
      let accepted = true;
      try {
        JSON.parse(damaged);
      } catch {
        accepted = false;
      }
      expect(parseJson(damaged, { strict: true }).ok, damaged).toBe(accepted);
      for (const strict of [true, false]) {
        const result = parseJson(damaged, { strict });
        if (!result.ok) {
          expect(result.error.offset).toBeGreaterThanOrEqual(0);
          expect(result.error.offset).toBeLessThanOrEqual(damaged.length);
          expect(result.error.line).toBeGreaterThanOrEqual(1);
          expect(result.error.column).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
});

describe('very large integers', () => {
  it('are read, counted as too long for a number, and kept as written', () => {
    const big = '1'.padEnd(400, '0');
    const root = node(`[${big}]`);
    expect(statsOf(root).bigNumbers).toBe(1);
    expect(formatJson(root, { indent: 0, sortKeys: false })).toBe(`[${big}]`);
  });
});
