import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  ALIAS_LIMIT,
  MAX_INPUT_CHARS,
  MAX_NODES,
  MAX_OUTPUT_CHARS,
  checkData,
  convert,
  isFormat,
  isInput,
  outputEstimate,
  runTask,
  type ConvertError,
  type Format,
  type Input,
  type Output,
} from '../../src/tools/json-yaml-xml/convert.ts';

const base: Omit<Input, 'from' | 'to' | 'text'> = {
  indent: 2,
  sortKeys: false,
  rootName: 'root',
  typed: false,
  declaration: false,
};

function run(from: Format, to: Format, text: string, extra: Partial<Input> = {}): Output {
  return convert({ ...base, from, to, text, ...extra });
}

function ok(from: Format, to: Format, text: string, extra: Partial<Input> = {}): string {
  const result = run(from, to, text, extra);
  if (!result.ok) {
    throw new Error(`failed: ${JSON.stringify(result.error)}`);
  }
  return result.text;
}

function error(from: Format, to: Format, text: string, extra: Partial<Input> = {}): ConvertError {
  const result = run(from, to, text, extra);
  if (result.ok) {
    throw new Error(`converted without an error: ${result.text}`);
  }
  return result.error;
}

describe('guards', () => {
  it('knows the formats', () => {
    expect(isFormat('json')).toBe(true);
    expect(isFormat('yaml')).toBe(true);
    expect(isFormat('xml')).toBe(true);
    expect(isFormat('csv')).toBe(false);
    expect(isFormat(1)).toBe(false);
  });

  it('accepts a complete input and nothing else', () => {
    const input: Input = { ...base, from: 'json', to: 'xml', text: '{}' };
    expect(isInput(input)).toBe(true);
    expect(isInput({ ...input, indent: 'tab' })).toBe(true);
    expect(isInput({ ...input, indent: 0 })).toBe(true);
    expect(isInput({ ...input, indent: 4 })).toBe(true);
    expect(isInput(null)).toBe(false);
    expect(isInput('x')).toBe(false);
    for (const broken of [
      { from: 'csv' },
      { to: 'csv' },
      { text: 1 },
      { indent: 3 },
      { sortKeys: 'yes' },
      { rootName: 1 },
      { typed: 1 },
      { declaration: 1 },
    ]) {
      expect(isInput({ ...input, ...broken })).toBe(false);
    }
  });

  it('runs as a task and reports its progress', () => {
    const calls: [number, number][] = [];
    const output = runTask(
      { ...base, from: 'json', to: 'yaml', text: '{"a":1}' },
      {
        progress: (done, total) => {
          calls.push([done, total]);
        },
      },
    );
    expect(output).toEqual({ ok: true, text: 'a: 1\n', notes: [] });
    expect(calls).toEqual([[1, 1]]);
  });
});

describe('JSON to YAML and XML', () => {
  const json = '{"name":"stuffcloud","tags":["a","b"],"nested":{"on":true,"n":1.5,"none":null}}';

  it('writes YAML', () => {
    expect(ok('json', 'yaml', json)).toBe(
      'name: stuffcloud\ntags:\n  - a\n  - b\nnested:\n  on: true\n  n: 1.5\n  none: null\n',
    );
    expect(ok('json', 'yaml', json, { indent: 4 })).toContain('tags:\n    - a\n    - b\n');
  });

  it('writes XML, and says that null became an empty element', () => {
    const result = run('json', 'xml', json);
    expect(result).toEqual({
      ok: true,
      text: [
        '<root>',
        '  <name>stuffcloud</name>',
        '  <tags>a</tags>',
        '  <tags>b</tags>',
        '  <nested>',
        '    <on>true</on>',
        '    <n>1.5</n>',
        '    <none/>',
        '  </nested>',
        '</root>',
      ].join('\n'),
      notes: [{ kind: 'nulls', count: 1 }],
    });
  });

  it('uses the root name and the declaration options', () => {
    expect(ok('json', 'xml', '[1]', { rootName: 'list', indent: 0, declaration: true })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><list><item>1</item></list>',
    );
  });

  it('accepts JSON5 and comments as input', () => {
    expect(ok('json', 'yaml', "// c\n{a: 'x', b: [1,],}")).toBe('a: x\nb:\n  - 1\n');
  });

  it('tells when a number loses digits on the way (and not for JSON to JSON)', () => {
    const text = '{"id":12345678901234567890}';
    expect(run('json', 'yaml', text)).toMatchObject({
      ok: true,
      notes: [{ kind: 'bigNumbers', count: 1 }],
    });
    expect(ok('json', 'json', text, { indent: 0 })).toBe(text);
    expect(run('json', 'json', text)).toMatchObject({ notes: [] });
  });

  it('keeps __proto__ as a key', () => {
    expect(ok('json', 'yaml', '{"__proto__":{"x":1}}')).toBe('__proto__:\n  x: 1\n');
    expect(ok('json', 'xml', '{"__proto__":{"x":1}}', { indent: 0 })).toBe(
      '<__proto__><x>1</x></__proto__>',
    );
  });
});

describe('YAML to JSON and XML', () => {
  const yaml = [
    '# comment',
    'name: stuffcloud',
    'tags: [a, b]',
    'nested:',
    '  on: yes',
    '  n: 1.5',
    '',
  ].join('\n');

  it('writes JSON, reading YAML 1.2 (yes is a string)', () => {
    expect(JSON.parse(ok('yaml', 'json', yaml))).toEqual({
      name: 'stuffcloud',
      tags: ['a', 'b'],
      nested: { on: 'yes', n: 1.5 },
    });
    expect(ok('yaml', 'json', 'a: 1', { indent: 0 })).toBe('{"a":1}');
    expect(ok('yaml', 'json', 'a: 1', { indent: 'tab' })).toBe('{\n\t"a": 1\n}');
  });

  it('keeps shared values (anchors) as copies in JSON', () => {
    expect(JSON.parse(ok('yaml', 'json', 'a: &x [1, 2]\nb: *x\nc: *x'))).toEqual({
      a: [1, 2],
      b: [1, 2],
      c: [1, 2],
    });
  });

  it('writes XML', () => {
    expect(ok('yaml', 'xml', 'a:\n  b: 1\n  c: [x, y]', { indent: 0 })).toBe(
      '<a><b>1</b><c>x</c><c>y</c></a>',
    );
  });

  it('reads a document with only comments as null', () => {
    expect(ok('yaml', 'json', '# nothing here')).toBe('null');
  });

  it('keeps __proto__ as a key', () => {
    expect(ok('yaml', 'json', '__proto__:\n  x: 1', { indent: 0 })).toBe('{"__proto__":{"x":1}}');
  });

  it('writes the infinities to YAML but refuses them for JSON and XML, with the path', () => {
    expect(ok('yaml', 'yaml', 'a: .inf\nb: .nan')).toBe('a: .inf\nb: .nan\n');
    expect(error('yaml', 'json', 'a: [1, .inf]')).toMatchObject({
      where: 'write',
      code: 'notFinite',
      found: 'Infinity',
      path: '$.a[1]',
    });
    expect(error('yaml', 'xml', 'a: .nan')).toMatchObject({
      code: 'notFinite',
      found: 'NaN',
      path: '$.a',
    });
  });
});

describe('XML to JSON and YAML', () => {
  const xml =
    '<?xml version="1.0"?><shop id="7"><name>A &amp; B</name><item n="1">x</item><item>y</item><price>9.50</price><on>true</on></shop>';

  it('writes JSON with @_ attributes and #text', () => {
    expect(JSON.parse(ok('xml', 'json', xml))).toEqual({
      shop: {
        '@_id': '7',
        name: 'A & B',
        item: [{ '@_n': '1', '#text': 'x' }, 'y'],
        price: '9.50',
        on: 'true',
      },
    });
  });

  it('writes numbers and booleans as such only when asked, and only when lossless', () => {
    const typed = JSON.parse(ok('xml', 'json', xml, { typed: true })) as {
      shop: Record<string, unknown>;
    };
    expect(typed.shop['@_id']).toBe(7);
    expect(typed.shop['price']).toBe('9.50');
    expect(typed.shop['on']).toBe(true);
    const more = JSON.parse(
      ok(
        'xml',
        'json',
        '<r><a>007</a><b>1e3</b><c>-0.5</c><d>false</d><e>99999999999999999999</e><f> 1</f></r>',
        {
          typed: true,
        },
      ),
    ) as { r: Record<string, unknown> };
    expect(more.r).toEqual({
      a: '007',
      b: '1e3',
      c: -0.5,
      d: false,
      e: '99999999999999999999',
      f: ' 1',
    });
  });

  it('writes YAML', () => {
    expect(ok('xml', 'yaml', '<a x="1"><b>t</b></a>')).toBe('a:\n  "@_x": "1"\n  b: t\n');
  });

  it('converts a document with entities in text and attributes', () => {
    expect(JSON.parse(ok('xml', 'json', '<a b="&lt;">&#x41;&amp;</a>'))).toEqual({
      a: { '@_b': '<', '#text': 'A&' },
    });
  });
});

describe('round trips of representative documents', () => {
  const documents: Record<string, unknown> = {
    config: {
      server: { host: 'localhost', port: 8080, tls: false },
      routes: [
        { path: '/a', methods: ['GET', 'POST'] },
        { path: '/b', methods: ['GET', 'HEAD'] },
      ],
      title: 'Ünïcode 日本語 😀',
      text: 'two\nlines',
    },
    scalars: { a: 1, b: -2.5, c: 'x', d: true, e: false, f: 0 },
    shop: {
      order: [
        { id: 1, items: ['x', 'y'] },
        { id: 2, items: ['z', 'w'] },
      ],
    },
  };

  const pairs: [Format, Format][] = [
    ['json', 'yaml'],
    ['json', 'xml'],
    ['yaml', 'json'],
    ['yaml', 'xml'],
    ['xml', 'json'],
    ['xml', 'yaml'],
  ];

  for (const [name, value] of Object.entries(documents)) {
    it.each(pairs)(`${name}: %s to %s and back is the same document`, (from, to) => {
      const document = { [name]: value };
      const start = JSON.stringify(document);
      // Everything goes through JSON as the neutral form; XML needs the typed option to get numbers back.
      const toFormat = (text: string, source: Format, target: Format): string =>
        ok(source, target, text, { typed: source === 'xml' });
      const first = from === 'json' ? start : toFormat(start, 'json', from);
      const there = toFormat(first, from, to);
      const back = toFormat(there, to, from);
      const json = from === 'json' ? back : toFormat(back, from, 'json');
      expect(JSON.parse(json)).toEqual(document);
    });
  }

  it('wraps a document that has no single root, which comes back inside the wrapper', () => {
    const there = ok('json', 'xml', '{"a":1,"b":[1,2]}', { indent: 0 });
    expect(there).toBe('<root><a>1</a><b>1</b><b>2</b></root>');
    expect(JSON.parse(ok('xml', 'json', there, { typed: true }))).toEqual({
      root: { a: 1, b: [1, 2] },
    });
  });

  it('writes a one-item list as a single element, which reads back as that item', () => {
    const there = ok('json', 'xml', '{"r":{"a":[1]}}', { indent: 0 });
    expect(JSON.parse(ok('xml', 'json', there, { typed: true }))).toEqual({ r: { a: 1 } });
  });

  it('XML written as text only comes back as text', () => {
    const there = ok('json', 'xml', '{"a":{"b":1,"c":true}}');
    expect(JSON.parse(ok('xml', 'json', there))).toEqual({ a: { b: '1', c: 'true' } });
  });
});

describe('options', () => {
  it('sorts keys in every target', () => {
    const text = '{"b":1,"a":{"d":2,"c":3}}';
    expect(ok('json', 'json', text, { sortKeys: true, indent: 0 })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(ok('json', 'yaml', text, { sortKeys: true })).toBe('a:\n  c: 3\n  d: 2\nb: 1\n');
    expect(ok('yaml', 'json', 'b: 1\na: {d: 2, c: 3}', { sortKeys: true, indent: 0 })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(
      ok('json', 'xml', '{"r":{"b":1,"a":[{"z":1,"y":2}]}}', { sortKeys: true, indent: 0 }),
    ).toBe('<r><a><y>2</y><z>1</z></a><b>1</b></r>');
  });

  it('keeps the order of keys without it', () => {
    expect(ok('json', 'json', '{"b":1,"a":2}', { indent: 0 })).toBe('{"b":1,"a":2}');
  });

  it('does not fold long YAML lines', () => {
    const long = 'word '.repeat(60).trim();
    expect(ok('json', 'yaml', JSON.stringify({ a: long }))).toBe(`a: ${long}\n`);
  });
});

describe('errors in the input', () => {
  it('says where JSON is wrong, and what was expected', () => {
    expect(error('json', 'yaml', '{\n  "a": 1\n  "b": 2\n}')).toEqual({
      where: 'read',
      format: 'json',
      code: 'unexpectedChar',
      line: 3,
      column: 3,
      found: '"',
      expected: 'commaOrBrace',
    });
    expect(error('json', 'yaml', '{"a": NaN}')).toMatchObject({
      code: 'notRepresentable',
      line: 1,
      column: 7,
    });
    expect(error('json', 'xml', '['.repeat(600))).toMatchObject({ code: 'tooDeep', max: 512 });
  });

  it('says where YAML is wrong, with the message of the reader', () => {
    const problem = error('yaml', 'json', 'a:\n  b: 1\n c: 2');
    expect(problem).toMatchObject({ where: 'read', format: 'yaml', line: 3 });
    expect(problem.detail).toEqual(expect.any(String));
    expect(problem.code).toEqual(expect.any(String));
    expect(error('yaml', 'json', 'a: 1\na: 2')).toMatchObject({
      code: 'DUPLICATE_KEY',
      line: 2,
      column: 1,
    });
    expect(error('yaml', 'json', 'a: 1\n---\nb: 2')).toMatchObject({ code: 'MULTIPLE_DOCS' });
    expect(error('yaml', 'json', 'a: [1, 2')).toMatchObject({ where: 'read', format: 'yaml' });
    expect(error('yaml', 'json', '\t- a')).toMatchObject({ where: 'read', format: 'yaml' });
  });

  it('says where XML is wrong', () => {
    expect(error('xml', 'json', '<a>\n<b></a>')).toEqual({
      where: 'read',
      format: 'xml',
      code: 'mismatchedTag',
      line: 2,
      column: 6,
      found: 'a',
      expected: 'b',
    });
    expect(error('xml', 'json', '<a>&bogus;</a>')).toMatchObject({
      code: 'badReference',
      found: '&bogus;',
    });
  });

  it('says that there is nothing to convert', () => {
    for (const from of ['json', 'yaml', 'xml'] as const) {
      expect(error(from, 'json', ' \n ')).toEqual({ where: 'read', format: from, code: 'empty' });
    }
  });
});

describe('errors when writing', () => {
  it('names the key that is no XML name, with its path', () => {
    expect(error('json', 'xml', '{"a":{"b c":1}}')).toEqual({
      where: 'write',
      format: 'xml',
      code: 'badName',
      path: '$.a["b c"]',
      found: 'b c',
    });
  });

  it('refuses what XML cannot hold', () => {
    expect(error('json', 'xml', '{"a":[[1]]}')).toMatchObject({
      code: 'nestedArray',
      path: '$.a[0]',
    });
    expect(error('json', 'xml', '{"a":"\\u0001"}')).toMatchObject({
      code: 'badCharacter',
      found: 'U+0001',
    });
    expect(error('json', 'xml', '{"a":{"@_b":{}}}')).toMatchObject({ code: 'attributeValue' });
  });

  it('refuses a number that is too big for JSON or XML', () => {
    expect(error('json', 'yaml', '{"a": 1e999}')).toMatchObject({
      code: 'notFinite',
      found: 'Infinity',
      path: '$.a',
    });
    expect(ok('json', 'json', '{"a": 1e999}', { indent: 0 })).toBe('{"a":1e999}');
    expect(error('json', 'xml', '[1e999]')).toMatchObject({ code: 'notFinite', path: '$[0]' });
  });
});

describe('hostile documents', () => {
  it('refuses a billion laughs document in XML by its DOCTYPE, quickly', () => {
    const started = performance.now();
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><lolz>&lol3;</lolz>`;
    expect(error('xml', 'json', laughs)).toMatchObject({
      where: 'read',
      format: 'xml',
      code: 'dtd',
    });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('refuses a billion laughs document in YAML (aliases), quickly', () => {
    const lines = ['a: &a [lol, lol, lol, lol, lol, lol, lol, lol, lol]'];
    let previous = 'a';
    for (const name of ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
      lines.push(
        `${name}: &${name} [${Array.from({ length: 9 }, () => `*${previous}`).join(', ')}]`,
      );
      previous = name;
    }
    const started = performance.now();
    expect(error('yaml', 'json', lines.join('\n'))).toMatchObject({
      where: 'read',
      format: 'yaml',
      code: 'aliasLimit',
      max: ALIAS_LIMIT,
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('refuses an alias that is not defined', () => {
    expect(error('yaml', 'json', 'a: *nowhere')).toMatchObject({ where: 'read', format: 'yaml' });
  });

  it('refuses an input that is too long, and one nested too deeply', () => {
    expect(error('json', 'yaml', ' '.repeat(MAX_INPUT_CHARS + 1))).toEqual({
      where: 'limit',
      format: 'json',
      code: 'inputTooLarge',
      max: MAX_INPUT_CHARS,
    });
    expect(error('yaml', 'json', '['.repeat(100_000))).toMatchObject({
      where: 'read',
      format: 'yaml',
    });
    expect(error('xml', 'json', '<a>'.repeat(600))).toMatchObject({ code: 'tooDeep' });
  });

  it('refuses a document that has too many values', () => {
    const many = `[${'0,'.repeat(MAX_NODES)}0]`;
    expect(many.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
    expect(error('json', 'yaml', many)).toMatchObject({
      where: 'limit',
      code: 'tooManyValues',
      max: MAX_NODES,
    });
  });

  it('counts every use of a shared value', () => {
    // 40 aliases of a 60 000 value list: small as text, 2.4 million values when expanded.
    const items = Array.from({ length: 60_000 }, () => '0').join(', ');
    const uses = Array.from({ length: 40 }, () => '*a').join(', ');
    const result = run('yaml', 'json', `a: &a [${items}]\nb: [${uses}]`);
    expect(result).toMatchObject({ ok: false, error: { where: 'limit', code: 'tooManyValues' } });
  });

  it('refuses text that is too large once aliases are expanded', () => {
    const big = 'x'.repeat(1_000_000);
    const uses = Array.from({ length: 40 }, () => '*a').join(', ');
    expect(error('yaml', 'json', `a: &a ${big}\nb: [${uses}]`)).toMatchObject({
      where: 'limit',
      code: 'tooLarge',
    });
  });
});

describe('checkData', () => {
  it('counts nulls and passes plain data', () => {
    expect(checkData({ a: [null, 1, 'x', true, { b: null }] }, true)).toMatchObject({
      nulls: 2,
      nodes: 8,
    });
    expect(checkData(Object.create(null) as object, true)).toMatchObject({ nulls: 0, nodes: 1 });
  });

  it('refuses what is not plain data, with the path', () => {
    for (const [value, found] of [
      [new Date(0), 'object'],
      [new Map(), 'object'],
      [10n, 'bigint'],
      [undefined, 'undefined'],
      [() => 1, 'function'],
      [Symbol('s'), 'symbol'],
    ] as const) {
      expect(() => checkData({ list: [value] }, false)).toThrow();
      try {
        checkData({ list: [value] }, false);
      } catch (thrown: unknown) {
        expect((thrown as { error: ConvertError }).error).toEqual({
          where: 'write',
          format: 'json',
          code: 'notData',
          found,
          path: '$.list[0]',
        });
      }
    }
  });

  it('refuses infinite numbers only when asked to', () => {
    expect(() => checkData([Infinity], true)).toThrow();
    expect(checkData([Infinity, NaN], false)).toMatchObject({ nulls: 0, nodes: 3 });
  });
});

describe('property: JSON through every format', () => {
  it('YAML written from random JSON reads back to the same value', () => {
    let state = 12345;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const generate = (depth: number): unknown => {
      const kind = Math.floor(next() * (depth > 3 ? 4 : 6));
      switch (kind) {
        case 0:
          return null;
        case 1:
          return next() < 0.5;
        case 2:
          return Math.round((next() - 0.5) * 1e4) / 10;
        case 3:
          return [
            '',
            'x',
            'true',
            'null',
            '123',
            '1e3',
            ' padded ',
            'a: b',
            '- c',
            '# d',
            'multi\nline',
            'ü😀',
            "it's",
            '"q"',
            '~',
            'yes',
            '0x1f',
            '.5',
          ][Math.floor(next() * 18)];
        case 4:
          return Array.from({ length: Math.floor(next() * 4) }, () => generate(depth + 1));
        default:
          return Object.fromEntries(
            Array.from({ length: Math.floor(next() * 4) }, (_, index) => [
              `${['k', 'on', 'null', '1', 'a b', 'é', ''][Math.floor(next() * 7)] ?? ''}${String(index)}`,
              generate(depth + 1),
            ]),
          );
      }
    };
    for (let round = 0; round < 300; round += 1) {
      const value = generate(0);
      const json = JSON.stringify(value);
      for (const indent of [2, 4] as const) {
        const yaml = ok('json', 'yaml', json, { indent });
        expect(parseYaml(yaml), yaml).toEqual(value);
        expect(JSON.parse(ok('yaml', 'json', yaml))).toEqual(value);
      }
    }
  });
});

describe('what the result will take', () => {
  it('refuses a small document that would become a huge text through its indentation', () => {
    const text = `${'['.repeat(500)}${'0,'.repeat(200_000)}0${']'.repeat(500)}`;
    expect(text.length).toBeLessThan(MAX_INPUT_CHARS);
    expect(error('json', 'json', text)).toEqual({
      where: 'limit',
      format: 'json',
      code: 'tooLarge',
      max: MAX_OUTPUT_CHARS,
    });
    expect(error('json', 'yaml', text, { indent: 4 })).toMatchObject({ code: 'tooLarge' });
    expect(error('json', 'xml', text, { indent: 'tab' })).toMatchObject({ code: 'tooLarge' });
  });

  it('writes the same document without indentation, which costs nothing per level', () => {
    const text = `${'['.repeat(500)}${'0,'.repeat(200_000)}0${']'.repeat(500)}`;
    const out = ok('json', 'json', text, { indent: 0 });
    expect(out.length).toBe(text.length);
  });

  it('estimates by nodes, depth, characters and indent', () => {
    const checked = { nulls: 0, nodes: 10, depthSum: 100, characters: 20 };
    expect(outputEstimate(checked, 0)).toBe(10 * 8 + 20 * 6);
    expect(outputEstimate(checked, 2)).toBe(10 * 8 + 200 + 20 * 6);
    expect(outputEstimate(checked, 4)).toBe(10 * 8 + 400 + 20 * 6);
    expect(outputEstimate(checked, 'tab')).toBe(10 * 8 + 100 + 20 * 6);
  });

  it('counts a value used again and again by YAML aliases for what it will cost', () => {
    const checked = checkData({ a: ['x', 'y'], b: 'z' }, true);
    // The key of a list is counted once for each item (XML writes it that often).
    expect(checked).toMatchObject({ nodes: 5, characters: 7, nulls: 0 });
    expect(checked.depthSum).toBe(1 + 2 + 3 + 3 + 2);
  });
});

describe('more limits and errors', () => {
  it('says a YAML document nested beyond what the reader can take is nested too deeply', () => {
    expect(error('yaml', 'json', `${'['.repeat(60_000)}${']'.repeat(60_000)}`)).toMatchObject({
      where: 'read',
      format: 'yaml',
      code: 'tooDeep',
    });
  });

  it('says a YAML document nested deeper than the limit, which it can read, is nested too deeply', () => {
    expect(error('yaml', 'json', `${'['.repeat(600)}${']'.repeat(600)}`)).toEqual({
      where: 'limit',
      format: 'json',
      code: 'tooDeep',
      max: 512,
    });
  });

  it('names the place of a number that cannot be written, also under an odd key', () => {
    expect(error('json', 'xml', '{"a-b":{"c":[1e999]}}')).toMatchObject({
      code: 'notFinite',
      path: '$["a-b"].c[0]',
    });
  });
});

describe('what a small document can make of itself', () => {
  it('counts the key of a list once for every item, because XML writes it for every item', () => {
    const items = Array.from({ length: 200_000 }, () => 1).join(',');
    const text = `{"${'k'.repeat(1000)}":[${items}]}`;
    expect(text.length).toBeLessThan(MAX_INPUT_CHARS);
    expect(error('json', 'xml', text, { indent: 0 })).toMatchObject({
      where: 'limit',
      code: 'tooLarge',
    });
  });

  it('does not let a YAML 1.1 line switch on merge keys, which copy', () => {
    const merged = JSON.parse(
      ok(
        'yaml',
        'json',
        ['%YAML 1.1', '---', 'a: &a {x: 1}', 'b:', '  <<: *a', '  y: 2'].join('\n'),
        { indent: 0 },
      ),
    ) as { b: Record<string, unknown> };
    expect(Object.keys(merged.b)).toEqual(['<<', 'y']);
  });

  it('allows as many aliases as are needed for a real document, and no more', () => {
    const uses = Array.from(
      { length: ALIAS_LIMIT - 1 },
      (_, index) => `k${String(index)}: *a`,
    ).join('\n');
    expect(ok('yaml', 'json', `a: &a [1]\n${uses}`, { indent: 0 })).toContain('"k0":[1]');
    expect(error('yaml', 'json', `a: &a [1]\n${uses}\nextra: *a`)).toMatchObject({
      code: 'aliasLimit',
    });
  });
});
