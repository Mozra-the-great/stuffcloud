import { describe, expect, it, vi } from 'vitest';
import { CASE_STYLES, convertCase, wordsOf, type CaseStyle } from '../../src/tools/textops/case.ts';
import { countText } from '../../src/tools/textops/count.ts';
import {
  dedupeLines,
  joinLines,
  numberLines,
  sortLines,
  splitLines,
  trimLines,
} from '../../src/tools/textops/lines.ts';
import { compile, escapePattern, replaceText } from '../../src/tools/textops/replace.ts';
import { slugify } from '../../src/tools/textops/slug.ts';
import { isInput, runTask, type Input } from '../../src/tools/textops/task.ts';

const B = String.fromCharCode(92);

describe('wordsOf', () => {
  it.each([
    ['fooBar', ['foo', 'Bar']],
    ['foo_bar-baz qux', ['foo', 'bar', 'baz', 'qux']],
    ['XMLHttpRequest', ['XML', 'Http', 'Request']],
    ['userID', ['user', 'ID']],
    ['version2Beta', ['version', '2', 'Beta']],
    ['HTML5', ['HTML', '5']],
    ['a', ['a']],
    ['A', ['A']],
    ['ÜberGröße', ['Über', 'Größe']],
    ['  ', []],
    ['', []],
    ['--__--', []],
    ['日本語テキスト', ['日本語テキスト']],
  ])('splits %j into %j', (input, words) => {
    expect(wordsOf(input)).toEqual(words);
  });
});

describe('convertCase', () => {
  const cases: readonly (readonly [CaseStyle, string, string])[] = [
    ['upper', 'Hello wörld ß', 'HELLO WÖRLD SS'],
    ['lower', 'Hello WÖRLD', 'hello wörld'],
    ['title', "hello wORLD it's o'neil's 3rd", "Hello World It's O'neil's 3rd"],
    ['sentence', 'hELLO wORLD. this is it! really? yes', 'Hello world. This is it! Really? Yes'],
    ['sentence', '"quoted" text', '"Quoted" text'],
    ['camel', 'hello big world', 'helloBigWorld'],
    ['camel', 'Hello_Big-World', 'helloBigWorld'],
    ['pascal', 'hello big world', 'HelloBigWorld'],
    ['pascal', 'XML http request', 'XmlHttpRequest'],
    ['snake', 'Hello Big World', 'hello_big_world'],
    ['snake', 'helloBigWorld', 'hello_big_world'],
    ['kebab', 'Hello Big World', 'hello-big-world'],
    ['kebab', 'XMLHttpRequest', 'xml-http-request'],
    ['constant', 'helloBigWorld', 'HELLO_BIG_WORLD'],
    ['constant', 'a b2 c', 'A_B_2_C'],
  ];
  it.each(cases)('%s: %j gives %j', (style, input, output) => {
    expect(convertCase(input, style)).toBe(output);
  });

  it('converts every line on its own and keeps the line breaks, also CRLF', () => {
    expect(convertCase('first one\nsecond one', 'camel')).toBe('firstOne\nsecondOne');
    expect(convertCase('a b\r\nc d\r\n', 'snake')).toBe('a_b\r\nc_d\r\n');
    expect(convertCase('one\n\ntwo', 'upper')).toBe('ONE\n\nTWO');
    expect(convertCase('', 'camel')).toBe('');
  });

  it('is a function of the text only: the same result for every style on an empty line', () => {
    for (const style of CASE_STYLES) {
      expect(convertCase('', style)).toBe('');
      expect(convertCase('\n', style)).toBe('\n');
    }
  });

  it('does not change a text that is already in the style', () => {
    for (const [style, text] of [
      ['camel', 'helloBigWorld'],
      ['pascal', 'HelloBigWorld'],
      ['snake', 'hello_big_world'],
      ['kebab', 'hello-big-world'],
      ['constant', 'HELLO_BIG_WORLD'],
    ] as const) {
      expect(convertCase(text, style)).toBe(text);
    }
  });
});

describe('lines', () => {
  it('splits at LF and CRLF, and a final line break does not make a line', () => {
    expect(splitLines('')).toEqual({ lines: [], trailingBreak: false });
    expect(splitLines('a')).toEqual({ lines: ['a'], trailingBreak: false });
    expect(splitLines('a\nb\n')).toEqual({ lines: ['a', 'b'], trailingBreak: true });
    expect(splitLines('a\r\nb')).toEqual({ lines: ['a', 'b'], trailingBreak: false });
    expect(splitLines('\n')).toEqual({ lines: [''], trailingBreak: true });
    expect(splitLines('a\n\n')).toEqual({ lines: ['a', ''], trailingBreak: true });
  });

  it('joins with LF and puts the final line break back', () => {
    expect(joinLines([], true)).toBe('');
    expect(joinLines(['a', 'b'], false)).toBe('a\nb');
    expect(joinLines(['a', 'b'], true)).toBe('a\nb\n');
  });
});

describe('sortLines', () => {
  const base = { descending: false, ignoreCase: false, numeric: false, locale: 'en' };

  it('sorts ascending and descending, and keeps the final line break', () => {
    expect(sortLines('b\nc\na\n', base)).toBe('a\nb\nc\n');
    expect(sortLines('b\nc\na', { ...base, descending: true })).toBe('c\nb\na');
    expect(sortLines('', base)).toBe('');
    expect(sortLines('only', base)).toBe('only');
  });

  it('puts lowercase before uppercase of the same letter, or ignores the case', () => {
    expect(sortLines('B\na\nA\nb', base)).toBe('a\nA\nb\nB');
    expect(sortLines('B\nb\nA\na', { ...base, ignoreCase: true }).toLowerCase()).toBe('a\na\nb\nb');
  });

  it('sorts numbers by value only on request', () => {
    expect(sortLines('item 10\nitem 2\nitem 1', base)).toBe('item 1\nitem 10\nitem 2');
    expect(sortLines('item 10\nitem 2\nitem 1', { ...base, numeric: true })).toBe(
      'item 1\nitem 2\nitem 10',
    );
  });

  it('follows the order of the language', () => {
    expect(sortLines('z\nä\na', { ...base, locale: 'de' })).toBe('a\nä\nz');
    expect(sortLines('z\nä\na', { ...base, locale: 'sv' })).toBe('a\nz\nä');
  });

  it('keeps empty lines and is stable for equal lines', () => {
    expect(sortLines('b\n\na\n\n', base)).toBe('\n\na\nb\n');
    const equal = sortLines('a\nA\na', { ...base, ignoreCase: true });
    expect(equal).toBe('a\nA\na');
  });
});

describe('dedupeLines', () => {
  const base = { ignoreCase: false, ignoreWhitespace: false };

  it('keeps the first of each group in its place and counts the others', () => {
    expect(dedupeLines('a\nb\na\nc\nb\n', base)).toEqual({ text: 'a\nb\nc\n', removed: 2 });
    expect(dedupeLines('', base)).toEqual({ text: '', removed: 0 });
    expect(dedupeLines('x\nx\nx', base)).toEqual({ text: 'x', removed: 2 });
    expect(dedupeLines('\n\n\n', base)).toEqual({ text: '\n', removed: 2 });
  });

  it('tells case and white space apart only when asked not to', () => {
    expect(dedupeLines('a\nA\n a \na  b\na b', base).removed).toBe(0);
    expect(dedupeLines('a\nA\nb', { ...base, ignoreCase: true })).toEqual({
      text: 'a\nb',
      removed: 1,
    });
    expect(dedupeLines('a\n a \n\ta', { ...base, ignoreWhitespace: true })).toEqual({
      text: 'a',
      removed: 2,
    });
    expect(dedupeLines('a  b\na b\nA B', { ignoreCase: true, ignoreWhitespace: true })).toEqual({
      text: 'a  b',
      removed: 2,
    });
  });
});

describe('trimLines', () => {
  const base = { mode: 'both' as const, removeEmptyLines: false, collapse: false };

  it('trims one or both ends of every line', () => {
    expect(trimLines('  a  \n\tb\t', base)).toBe('a\nb');
    expect(trimLines('  a  \n  b  ', { ...base, mode: 'start' })).toBe('a  \nb  ');
    expect(trimLines('  a  \n  b  ', { ...base, mode: 'end' })).toBe('  a\n  b');
  });

  it('removes empty and blank lines on request', () => {
    expect(trimLines('a\n\n  \nb\n', base)).toBe('a\n\n\nb\n');
    expect(trimLines('a\n\n  \nb\n', { ...base, removeEmptyLines: true })).toBe('a\nb\n');
    expect(trimLines('a\n\n  \nb', { ...base, mode: 'end', removeEmptyLines: true })).toBe('a\nb');
  });

  it('makes runs of spaces and tabs one space on request, and leaves other text alone', () => {
    expect(trimLines('a   b\t\tc', { ...base, collapse: true })).toBe('a b c');
    expect(trimLines('a   b', base)).toBe('a   b');
    expect(trimLines('', { ...base, collapse: true })).toBe('');
  });
});

describe('numberLines', () => {
  it('numbers from the start with the separator, and aligns on request', () => {
    const base = { start: 1, separator: ': ', pad: false };
    expect(numberLines('a\nb\nc', base)).toBe('1: a\n2: b\n3: c');
    expect(numberLines('a\nb\n', base)).toBe('1: a\n2: b\n');
    expect(numberLines('a\nb', { ...base, start: 0, separator: '\t' })).toBe('0\ta\n1\tb');
    const ten = Array.from({ length: 10 }, (_, index) => `l${String(index)}`).join('\n');
    expect(numberLines(ten, { ...base, pad: true }).split('\n')[0]).toBe(' 1: l0');
    expect(numberLines(ten, { ...base, pad: true }).split('\n')[9]).toBe('10: l9');
    expect(numberLines(ten, base).split('\n')[0]).toBe('1: l0');
    expect(numberLines('', base)).toBe('');
  });

  it('counts from a negative start and pads by the widest number', () => {
    expect(numberLines('a\nb\nc', { start: -1, separator: ' ', pad: false })).toBe(
      '-1 a\n0 b\n1 c',
    );
    expect(numberLines('a\nb', { start: 99, separator: ' ', pad: true })).toBe(' 99 a\n100 b');
    expect(numberLines('a\nb', { start: -10, separator: ' ', pad: true })).toBe('-10 a\n -9 b');
  });
});

describe('escapePattern and compile', () => {
  it('escapes every character that means something in a pattern', () => {
    expect(escapePattern('a.b*c?')).toBe(`a${B}.b${B}*c${B}?`);
    expect(escapePattern('(x)[y]{z}|^$+/-')).toBe(
      `${B}(x${B})${B}[y${B}]${B}{z${B}}${B}|${B}^${B}$${B}+${B}/${B}-`,
    );
    expect(escapePattern(B)).toBe(B + B);
    expect(escapePattern('plain text ünï')).toBe('plain text ünï');
  });

  it('matches exactly the text it escaped, whatever it contains', () => {
    for (const text of ['a.b', '[x]', '(', '$1', '^start', 'a|b', B, '*+?', '{1,2}']) {
      const compiled = compile({
        find: text,
        replacement: '',
        regex: false,
        ignoreCase: false,
        wholeWord: false,
      });
      expect(compiled.ok).toBe(true);
      if (compiled.ok) {
        expect(`x${text}y`.replace(compiled.pattern, '|')).toBe('x|y');
      }
    }
  });

  it('reports the browser message for a pattern that does not compile', () => {
    const compiled = compile({
      find: 'a(',
      replacement: '',
      regex: true,
      ignoreCase: false,
      wholeWord: false,
    });
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) {
      expect(compiled.message.length).toBeGreaterThan(5);
    }
  });
});

describe('replaceText', () => {
  const base = { find: '', replacement: '', regex: false, ignoreCase: false, wholeWord: false };

  it('replaces every occurrence of a plain text and counts them', () => {
    expect(replaceText('a.b.c', { ...base, find: '.', replacement: '-' })).toEqual({
      ok: true,
      text: 'a-b-c',
      count: 2,
    });
    expect(replaceText('abc', { ...base, find: 'x', replacement: '-' })).toEqual({
      ok: true,
      text: 'abc',
      count: 0,
    });
  });

  it('takes the replacement literally in plain mode, `$` included', () => {
    expect(replaceText('a b', { ...base, find: 'a', replacement: '$&$1$$' })).toEqual({
      ok: true,
      text: '$&$1$$ b',
      count: 1,
    });
  });

  it('ignores case on request and keeps it otherwise', () => {
    expect(replaceText('Aa', { ...base, find: 'a', replacement: 'x' }).ok).toBe(true);
    const strict = replaceText('Aa', { ...base, find: 'a', replacement: 'x' });
    expect(strict.ok && strict.text).toBe('Ax');
    const loose = replaceText('Aa', { ...base, find: 'a', replacement: 'x', ignoreCase: true });
    expect(loose.ok && loose.text).toBe('xx');
  });

  it('replaces whole words only on request, also next to non-ASCII letters', () => {
    const text = 'cat concat cat. Katze katzen _cat';
    const all = replaceText(text, { ...base, find: 'cat', replacement: 'dog' });
    expect(all.ok && all.text).toBe('dog condog dog. Katze katzen _dog');
    const whole = replaceText(text, { ...base, find: 'cat', replacement: 'dog', wholeWord: true });
    expect(whole.ok && whole.text).toBe('dog concat dog. Katze katzen _cat');
    const umlaut = replaceText('Tür Türen', {
      ...base,
      find: 'Tür',
      replacement: 'X',
      wholeWord: true,
    });
    expect(umlaut.ok && umlaut.text).toBe('X Türen');
  });

  it('works with a regular expression: groups, the whole match, named groups', () => {
    const swap = replaceText('2026-11-19', {
      ...base,
      find: `(${B}d+)-(${B}d+)-(${B}d+)`,
      replacement: '$3.$2.$1',
      regex: true,
    });
    expect(swap).toEqual({ ok: true, text: '19.11.2026', count: 1 });
    const whole = replaceText('a1 b22', {
      ...base,
      find: `${B}d+`,
      replacement: '<$&>',
      regex: true,
    });
    expect(whole).toEqual({ ok: true, text: 'a<1> b<22>', count: 2 });
    const named = replaceText('x=1', {
      ...base,
      find: '(?<key>[a-z])=(?<value>[0-9])',
      replacement: '$<value>=$<key>',
      regex: true,
    });
    expect(named).toEqual({ ok: true, text: '1=x', count: 1 });
  });

  it('lets ^ and $ match at every line', () => {
    const result = replaceText('a\nb\nc', { ...base, find: '^', replacement: '> ', regex: true });
    expect(result).toEqual({ ok: true, text: '> a\n> b\n> c', count: 3 });
    const end = replaceText('a\nb', { ...base, find: '$', replacement: ';', regex: true });
    expect(end).toEqual({ ok: true, text: 'a;\nb;', count: 2 });
  });

  it('wraps a whole-word regex so that an alternative cannot escape the word boundaries', () => {
    const result = replaceText('cat dog catdog', {
      ...base,
      find: 'cat|dog',
      replacement: 'x',
      regex: true,
      wholeWord: true,
    });
    expect(result).toEqual({ ok: true, text: 'x x catdog', count: 2 });
  });

  it('refuses an empty search text and reports a broken pattern', () => {
    expect(replaceText('abc', base)).toEqual({ ok: false, error: { code: 'find-empty' } });
    const broken = replaceText('abc', { ...base, find: '(', regex: true });
    expect(broken.ok).toBe(false);
    if (!broken.ok && broken.error.code === 'pattern') {
      expect(broken.error.message).not.toBe('');
    } else {
      throw new Error('expected a pattern error');
    }
    // A bare brace is a plain character in plain mode.
    expect(replaceText('a(b', { ...base, find: '(', replacement: '[' }).ok).toBe(true);
  });

  it('handles a non-Error throw from the constructor', () => {
    const original = globalThis.RegExp;
    vi.stubGlobal('RegExp', function Broken(): never {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'not an error object';
    });
    try {
      const compiled = compile({ ...base, find: 'a' });
      expect(compiled).toEqual({ ok: false, message: 'not an error object' });
    } finally {
      vi.stubGlobal('RegExp', original);
    }
  });
});

describe('slugify', () => {
  const base = { separator: '-' as const, asciiOnly: true, germanUmlauts: false };

  it.each([
    ['Hello, World!', 'hello-world'],
    ['  Many   spaces & symbols!! ', 'many-spaces-symbols'],
    ['Crème brûlée à la façon', 'creme-brulee-a-la-facon'],
    ['Straße Œuvre Æsir Øl Łódź Đorđe', 'strasse-oeuvre-aesir-ol-lodz-dorde'],
    ['Ärger über Öl', 'arger-uber-ol'],
    ['___a__b---c', 'a-b-c'],
    ['', ''],
    ['!!!', ''],
    ['日本語', ''],
    ['Version 2.0 (final)', 'version-2-0-final'],
  ])('turns %j into %j', (input, slug) => {
    expect(slugify(input, base)).toBe(slug);
  });

  it('writes German umlauts as ae, oe, ue on request', () => {
    expect(slugify('Ärger über Öl', { ...base, germanUmlauts: true })).toBe('aerger-ueber-oel');
    expect(slugify('Größe', { ...base, germanUmlauts: true })).toBe('groesse');
  });

  it('uses the chosen separator', () => {
    expect(slugify('Hello big World', { ...base, separator: '_' })).toBe('hello_big_world');
  });

  it('keeps letters of other scripts when ASCII only is off', () => {
    const open = { ...base, asciiOnly: false };
    expect(slugify('日本語 テキスト', open)).toBe('日本語-テキスト');
    expect(slugify('Привет, мир!', open)).toBe('привет-мир');
    expect(slugify('Crème brûlée', open)).toBe('creme-brulee');
    expect(slugify('हिन्दी भाषा', open)).toBe('हिन्दी-भाषा');
  });

  it('makes one slug per line', () => {
    expect(slugify('First Title\r\nSecond Title\n\nThird', base)).toBe(
      'first-title\nsecond-title\n\nthird',
    );
  });

  it('only ever makes a-z, 0-9 and the separator in ASCII mode (property)', () => {
    let state = 5;
    const next = (limit: number): number => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return Math.floor((state / 4_294_967_296) * limit);
    };
    const characters = Array.from(
      new Intl.Segmenter().segment('aZ09 -_.,;!?ßäöüéñ日本😀\t'),
      (p) => p.segment,
    );
    for (let round = 0; round < 200; round += 1) {
      const text = Array.from(
        { length: next(40) },
        () => characters[next(characters.length)] ?? '',
      ).join('');
      const slug = slugify(text, base);
      expect(slug).toMatch(/^([a-z0-9]+(-[a-z0-9]+)*)?$/);
    }
  });
});

describe('countText', () => {
  it('counts an empty text as nothing', () => {
    expect(countText('')).toEqual({
      characters: 0,
      charactersWithoutSpaces: 0,
      words: 0,
      lines: 0,
      paragraphs: 0,
      bytes: 0,
    });
  });

  it('counts characters, words, lines and paragraphs of a text', () => {
    expect(countText('Hello world\n\nSecond paragraph here\nstill second\n')).toEqual({
      characters: 48,
      charactersWithoutSpaces: 40,
      words: 7,
      lines: 4,
      paragraphs: 2,
      bytes: 48,
    });
  });

  it('counts what a reader sees as one character as one', () => {
    // A family emoji (7 code points), an e with a combining accent, a flag, a CRLF.
    expect(countText('👨‍👩‍👧').characters).toBe(1);
    expect(countText('é').characters).toBe(1);
    expect(countText('🇩🇪').characters).toBe(1);
    expect(countText('a\r\nb').characters).toBe(3);
    expect(countText('a\r\nb').charactersWithoutSpaces).toBe(2);
  });

  it('counts bytes as UTF-8', () => {
    expect(countText('aä€😀').bytes).toBe(1 + 2 + 3 + 4);
  });

  it('counts words of scripts without spaces, and not punctuation', () => {
    expect(countText('Hello, world! ...').words).toBe(2);
    expect(countText('日本語のテキスト').words).toBeGreaterThan(1);
    expect(countText('   ').words).toBe(0);
  });

  it('counts lines: a final line break adds none, an empty line counts, CRLF is one break', () => {
    expect(countText('a').lines).toBe(1);
    expect(countText('a\n').lines).toBe(1);
    expect(countText('a\n\n').lines).toBe(2);
    expect(countText('\n').lines).toBe(1);
    expect(countText('a\r\nb\r\n').lines).toBe(2);
  });

  it('counts paragraphs: blocks split by one or more blank lines, blank lines with spaces too', () => {
    expect(countText('a\nb').paragraphs).toBe(1);
    expect(countText('a\n\nb').paragraphs).toBe(2);
    expect(countText('a\n \t\nb\n\n\n\nc').paragraphs).toBe(3);
    expect(countText('\n\n\n').paragraphs).toBe(0);
    expect(countText('a\r\n\r\nb').paragraphs).toBe(2);
  });
});

describe('the task of the worker', () => {
  const progress = vi.fn();
  const input = (text: string, request: Input['request']): Input => ({ text, request });

  it('applies the operation and counts the input', () => {
    const output = runTask(
      input('b\na\n', {
        operation: 'sort',
        descending: false,
        ignoreCase: false,
        numeric: false,
        locale: 'en',
      }),
      { progress },
    );
    expect(output.result).toEqual({ ok: true, text: 'a\nb\n' });
    expect(output.counts.lines).toBe(2);
    expect(progress.mock.calls.slice(-2)).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });

  it('only counts when there is no request', () => {
    const output = runTask(input('one two', null), { progress });
    expect(output.result).toBeNull();
    expect(output.counts.words).toBe(2);
  });

  it('reports what an operation counted', () => {
    const removed = runTask(
      input('a\na\nb', { operation: 'dedupe', ignoreCase: false, ignoreWhitespace: false }),
      { progress },
    );
    expect(removed.result).toEqual({
      ok: true,
      text: 'a\nb',
      detail: { kind: 'removed', count: 1 },
    });
    const replaced = runTask(
      input('aXa', {
        operation: 'replace',
        find: 'a',
        replacement: 'b',
        regex: false,
        ignoreCase: false,
        wholeWord: false,
      }),
      { progress },
    );
    expect(replaced.result).toEqual({
      ok: true,
      text: 'bXb',
      detail: { kind: 'replaced', count: 2 },
    });
    const failed = runTask(
      input('a', {
        operation: 'replace',
        find: '',
        replacement: 'b',
        regex: false,
        ignoreCase: false,
        wholeWord: false,
      }),
      { progress },
    );
    expect(failed.result).toEqual({ ok: false, error: { code: 'find-empty' } });
  });

  it('runs every other operation', () => {
    const run = (request: Input['request']): unknown =>
      runTask(input('Hello World\n', request), { progress }).result;
    expect(run({ operation: 'case', style: 'snake' })).toEqual({ ok: true, text: 'hello_world\n' });
    expect(
      run({ operation: 'trim', mode: 'both', removeEmptyLines: false, collapse: false }),
    ).toEqual({ ok: true, text: 'Hello World\n' });
    expect(run({ operation: 'number', start: 1, separator: '. ', pad: false })).toEqual({
      ok: true,
      text: '1. Hello World\n',
    });
    expect(
      run({ operation: 'slug', separator: '-', asciiOnly: true, germanUmlauts: false }),
    ).toEqual({ ok: true, text: 'hello-world\n' });
  });
});

describe('the input guard of the worker', () => {
  const requests: readonly unknown[] = [
    { operation: 'case', style: 'camel' },
    { operation: 'sort', descending: true, ignoreCase: true, numeric: true, locale: 'de' },
    { operation: 'dedupe', ignoreCase: true, ignoreWhitespace: false },
    { operation: 'trim', mode: 'end', removeEmptyLines: true, collapse: true },
    { operation: 'number', start: -5, separator: '', pad: true },
    {
      operation: 'replace',
      find: 'a',
      replacement: '',
      regex: true,
      ignoreCase: false,
      wholeWord: true,
    },
    { operation: 'slug', separator: '_', asciiOnly: false, germanUmlauts: true },
  ];

  it.each(requests)('accepts %j, and null for a count only', (request) => {
    expect(isInput({ text: 'x', request })).toBe(true);
    expect(isInput({ text: 'x', request: null })).toBe(true);
  });

  it.each([
    null,
    'x',
    {},
    { text: 1, request: null },
    { text: 'x' },
    { text: 'x', request: 'case' },
    { text: 'x', request: {} },
    { text: 'x', request: { operation: 'explode' } },
    { text: 'x', request: { operation: 'case', style: 'shouting' } },
    { text: 'x', request: { operation: 'case', style: 7 } },
    {
      text: 'x',
      request: { operation: 'sort', descending: 1, ignoreCase: true, numeric: true, locale: 'en' },
    },
    {
      text: 'x',
      request: { operation: 'sort', descending: true, ignoreCase: true, numeric: true },
    },
    { text: 'x', request: { operation: 'dedupe', ignoreCase: true } },
    {
      text: 'x',
      request: { operation: 'trim', mode: 'middle', removeEmptyLines: true, collapse: true },
    },
    { text: 'x', request: { operation: 'trim', mode: 'both', removeEmptyLines: true } },
    { text: 'x', request: { operation: 'number', start: 1.5, separator: '', pad: true } },
    { text: 'x', request: { operation: 'number', start: 1, separator: 2, pad: true } },
    {
      text: 'x',
      request: { operation: 'replace', find: 'a', replacement: '', regex: true, ignoreCase: false },
    },
    {
      text: 'x',
      request: { operation: 'slug', separator: '+', asciiOnly: true, germanUmlauts: true },
    },
    { text: 'x', request: { operation: 'slug', separator: '-', asciiOnly: true } },
  ])('refuses %j', (value) => {
    expect(isInput(value)).toBe(false);
  });
});
