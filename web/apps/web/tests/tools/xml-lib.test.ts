import { describe, expect, it } from 'vitest';
import {
  MAX_XML_DEPTH,
  badCharacterAt,
  isXmlName,
  parseXml,
  setOwn,
  writeXml,
  type XmlError,
  type XmlObject,
  type XmlSource,
  type XmlValue,
  type XmlWriteError,
  type XmlWriteOptions,
} from '../../src/tools/json-yaml-xml/xml.ts';

function read(text: string): XmlObject {
  const result = parseXml(text);
  if (!result.ok) {
    throw new Error(`not parsed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function fails(text: string): XmlError {
  const result = parseXml(text);
  if (result.ok) {
    throw new Error(`parsed without an error: ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

const pretty: XmlWriteOptions = { indent: 2, rootName: 'root', declaration: false };
const compact: XmlWriteOptions = { indent: 0, rootName: 'root', declaration: false };

function write(value: XmlSource, options = pretty): string {
  const result = writeXml(value, options);
  if (!result.ok) {
    throw new Error(`not written: ${JSON.stringify(result.error)}`);
  }
  return result.text;
}

function writeFails(value: XmlSource, options = pretty): XmlWriteError {
  const result = writeXml(value, options);
  if (result.ok) {
    throw new Error(`written without an error: ${result.text}`);
  }
  return result.error;
}

describe('names and characters', () => {
  it.each(['a', 'A1', '_x', 'a-b.c', 'ns:tag', 'é', '日本語', 'a\u{b7}', 'a\u{300}'])(
    'accepts the name %s',
    (name) => {
      expect(isXmlName(name)).toBe(true);
    },
  );

  it.each(['', '1a', '-a', '.a', 'a b', 'a<b', 'a"b', '\u{b7}a', 'a\u{2028}'])(
    'refuses the name %j',
    (name) => {
      expect(isXmlName(name)).toBe(false);
    },
  );

  it('finds the first character XML 1.0 does not allow', () => {
    expect(badCharacterAt('fine \t\n\r \u{d7ff}\u{e000}\u{fffd}\u{10000}\u{10ffff}')).toBe(-1);
    expect(badCharacterAt('ab\u{0}c')).toBe(2);
    expect(badCharacterAt('a\u{8}')).toBe(1);
    expect(badCharacterAt('a\u{b}')).toBe(1);
    expect(badCharacterAt('a\u{fffe}')).toBe(1);
    expect(badCharacterAt('a\u{d800}')).toBe(1);
  });

  it('sets a property called __proto__ as an own property', () => {
    const target: Record<string, string> = {};
    setOwn(target, '__proto__', 'x');
    expect(Object.keys(target)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
  });
});

describe('parseXml: documents', () => {
  it('reads an element with text and an empty one', () => {
    expect(read('<a>x</a>')).toEqual({ a: 'x' });
    expect(read('<a/>')).toEqual({ a: '' });
    expect(read('<a></a>')).toEqual({ a: '' });
    expect(read('<a />')).toEqual({ a: '' });
  });

  it('keeps the text of a leaf as it is, white space included', () => {
    expect(read('<a>  x \n y </a>')).toEqual({ a: '  x \n y ' });
    expect(read('<a>   </a>')).toEqual({ a: '   ' });
  });

  it('reads attributes as @_name and the text next to them as #text', () => {
    expect(read(`<a id="1" b='2'>t</a>`)).toEqual({ a: { '@_id': '1', '@_b': '2', '#text': 't' } });
    expect(read('<a id="1"/>')).toEqual({ a: { '@_id': '1' } });
    expect(read('<a id="1">  </a>')).toEqual({ a: { '@_id': '1' } });
    expect(read('<a  id = "1"\n  b="2" ></a>')).toEqual({ a: { '@_id': '1', '@_b': '2' } });
  });

  it('turns repeated elements into an array, at the place of the first one', () => {
    expect(read('<r><a>1</a><b>x</b><a>2</a><a>3</a></r>')).toEqual({
      r: { a: ['1', '2', '3'], b: 'x' },
    });
    expect(Object.keys((read('<r><a>1</a><b>x</b><a>2</a></r>') as { r: object }).r)).toEqual([
      'a',
      'b',
    ]);
  });

  it('reads nested elements and drops the white space between them', () => {
    expect(read('<a>\n  <b>\n    <c>x</c>\n  </b>\n</a>')).toEqual({ a: { b: { c: 'x' } } });
  });

  it('puts the text of mixed content into #text, trimmed and joined', () => {
    expect(read('<p>Hello <b>big</b> world <i>!</i></p>')).toEqual({
      p: { b: 'big', i: '!', '#text': 'Hello world' },
    });
  });

  it('reads CDATA as text, also next to other text', () => {
    expect(read('<a><![CDATA[1 < 2 && <b>]]></a>')).toEqual({ a: '1 < 2 && <b>' });
    expect(read('<a>x<![CDATA[<y>]]>z</a>')).toEqual({ a: 'x<y>z' });
    expect(read('<a><![CDATA[l1\r\nl2]]></a>')).toEqual({ a: 'l1\nl2' });
  });

  it('drops comments, processing instructions and the declaration', () => {
    expect(
      read(
        '<?xml version="1.0" encoding="UTF-8"?>\n<!-- c --><?pi data?><a><!-- c -->x<?p?></a><!-- end -->',
      ),
    ).toEqual({ a: 'x' });
  });

  it('skips a DOCTYPE that has no internal subset, and never fetches it', () => {
    expect(
      read(
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "http://example.org/x.dtd"><html>x</html>',
      ),
    ).toEqual({ html: 'x' });
    expect(read('<!DOCTYPE a SYSTEM "a>b.dtd"><a/>')).toEqual({ a: '' });
    expect(read('<!DOCTYPE a><a/>')).toEqual({ a: '' });
  });

  it('knows the five predefined entities and character references', () => {
    expect(read('<a>&lt;&gt;&amp;&quot;&apos; &#65;&#x42;&#x1F600;</a>')).toEqual({
      a: '<>&"\' AB\u{1f600}',
    });
    expect(read('<a b="&lt;&amp;&#10;"/>')).toEqual({
      a: { '@_b': '<&' + String.fromCharCode(10) },
    });
  });

  it('normalises line ends in text and white space in attribute values', () => {
    expect(read('<a>x\r\ny\rz</a>')).toEqual({ a: 'x\ny\nz' });
    expect(read('<a b="x\ty\r\nz\nw"/>')).toEqual({ a: { '@_b': 'x y z w' } });
  });

  it('accepts a byte order mark, other names and prefixes', () => {
    expect(read('\u{feff}<a/>')).toEqual({ a: '' });
    expect(read('<ns:a xmlns:ns="urn:x" ns:id="1"><ns:b/></ns:a>')).toEqual({
      'ns:a': { '@_xmlns:ns': 'urn:x', '@_ns:id': '1', 'ns:b': '' },
    });
    expect(read('<日本語>é</日本語>')).toEqual({ 日本語: 'é' });
  });

  it('keeps __proto__ as an element name without touching the prototype', () => {
    const value = read('<r><__proto__>x</__proto__></r>');
    expect(Object.keys((value as { r: object }).r)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf((value as { r: object }).r)).toBe(Object.prototype);
  });

  it('reads a document nested as deep as allowed', () => {
    const deep = `${'<a>'.repeat(MAX_XML_DEPTH)}x${'</a>'.repeat(MAX_XML_DEPTH)}`;
    expect(parseXml(deep).ok).toBe(true);
    expect(fails('<a>'.repeat(MAX_XML_DEPTH + 1)).code).toBe('tooDeep');
  });
});

describe('parseXml: errors', () => {
  it.each<[string, XmlError['code'], number, number, string | undefined, string | undefined]>([
    ['', 'empty', 1, 1, undefined, undefined],
    ['  \n ', 'empty', 2, 2, undefined, undefined],
    ['<!-- only a comment -->', 'noRoot', 1, 24, undefined, undefined],
    ['<a/><b/>', 'multipleRoots', 1, 5, undefined, undefined],
    ['<a/>x', 'textOutsideRoot', 1, 5, undefined, undefined],
    ['x<a/>', 'textOutsideRoot', 1, 1, undefined, undefined],
    ['<![CDATA[x]]><a/>', 'textOutsideRoot', 1, 1, undefined, undefined],
    ['<a>', 'unexpectedEnd', 1, 4, 'a', undefined],
    ['<a><b></b>', 'unexpectedEnd', 1, 11, 'a', undefined],
    ['<a></b>', 'mismatchedTag', 1, 6, 'b', 'a'],
    ['<a>\n<b>\n</a>', 'mismatchedTag', 3, 3, 'a', 'b'],
    ['</a>', 'mismatchedTag', 1, 3, 'a', undefined],
    ['<a></a b>', 'badAttribute', 1, 8, 'b', undefined],
    ['<a></a', 'unterminated', 1, 4, undefined, undefined],
    ['<>', 'badName', 1, 2, '>', undefined],
    ['<1a/>', 'badName', 1, 2, '1', undefined],
    ['< a/>', 'badName', 1, 2, ' ', undefined],
    ['<', 'badName', 1, 2, undefined, undefined],
    ['<a b/>', 'badAttribute', 1, 4, 'b', undefined],
    ['<a b=1/>', 'badAttribute', 1, 4, 'b', undefined],
    ['<a b="1"c="2"/>', 'badAttribute', 1, 9, 'c', undefined],
    ['<a b="<"/>', 'badAttribute', 1, 7, '<', undefined],
    ['<a b="1" b="2"/>', 'duplicateAttribute', 1, 10, 'b', undefined],
    ['<a b="1', 'unterminated', 1, 6, undefined, undefined],
    ['<a b="1"', 'unterminated', 1, 1, undefined, undefined],
    ['<a/ >', 'badAttribute', 1, 4, ' ', undefined],
    ['<a>&nbsp;</a>', 'badReference', 1, 4, '&nbsp;', undefined],
    ['<a>&amp</a>', 'badReference', 1, 4, '&amp', undefined],
    ['<a>&</a>', 'badReference', 1, 4, '&', undefined],
    ['<a>&amp &lt;</a>', 'badReference', 1, 4, '&amp', undefined],
    ['<a>&#0;</a>', 'badReference', 1, 4, '&#0;', undefined],
    ['<a>&#xD800;</a>', 'badReference', 1, 4, '&#xD800;', undefined],
    ['<a>&#x110000;</a>', 'badReference', 1, 4, '&#x110000;', undefined],
    ['<a>&#xZ;</a>', 'badReference', 1, 4, '&#xZ;', undefined],
    ['<a b="&bogus;"/>', 'badReference', 1, 7, '&bogus;', undefined],
    ['<a>\u{1}</a>', 'badCharacter', 1, 4, '\u{1}', undefined],
    ['<a>x ]]> y</a>', 'badCharacter', 1, 6, ']]>', undefined],
    ['<a><!-- a -- b --></a>', 'badCharacter', 1, 11, '--', undefined],
    ['<a><!-- never', 'unterminated', 1, 4, undefined, undefined],
    ['<a><![CDATA[ never', 'unterminated', 1, 4, undefined, undefined],
    ['<a><? never', 'unterminated', 1, 4, undefined, undefined],
    ['<a><!x></a>', 'badName', 1, 6, 'x', undefined],
    ['<a/><!DOCTYPE a>', 'badName', 1, 7, 'DOCTYPE', undefined],
    ['<a><!DOCTYPE a></a>', 'badName', 1, 6, 'DOCTYPE', undefined],
    ['<!doctype a><a/>', 'badName', 1, 3, 'doctype', undefined],
    ['<!DOCTYPE a', 'unterminated', 1, 1, undefined, undefined],
  ])('%j is %s at %i:%i', (text, code, line, column, found, expected) => {
    const problem = fails(text);
    expect(problem.code).toBe(code);
    expect(problem.line).toBe(line);
    expect(problem.column).toBe(column);
    expect(problem.found).toBe(found);
    expect(problem.expected).toBe(expected);
  });

  it('refuses a DOCTYPE with an internal subset, entities included', () => {
    const problem = fails(
      '<?xml version="1.0"?>\n<!DOCTYPE lolz [\n<!ENTITY lol "lol">\n]>\n<lolz>&lol;</lolz>',
    );
    expect(problem).toMatchObject({ code: 'dtd', line: 2, column: 1 });
    expect(fails('<!DOCTYPE a [ ]><a/>').code).toBe('dtd');
    // A bracket inside a quoted literal of the identifier is not a subset.
    expect(read('<!DOCTYPE a SYSTEM "x[y.dtd"><a/>')).toEqual({ a: '' });
  });

  it('refuses a billion laughs document by its DOCTYPE, and a use of its entities without one', () => {
    const laughs = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE lolz [',
      '<!ENTITY lol "lol">',
      '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">',
      '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">',
      ']>',
      '<lolz>&lol3;</lolz>',
    ].join('\n');
    expect(fails(laughs).code).toBe('dtd');
    expect(fails('<lolz>&lol3;</lolz>').code).toBe('badReference');
  });

  it('refuses an external entity, which is never fetched', () => {
    expect(fails('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>').code).toBe(
      'dtd',
    );
    expect(fails('<a>&x;</a>').code).toBe('badReference');
  });

  it('refuses characters XML does not allow, where they are', () => {
    expect(fails('<a>\n\u{0}</a>')).toMatchObject({ code: 'badCharacter', line: 2, column: 1 });
    expect(fails('<a>\u{fffe}</a>').found).toBe('\u{fffe}');
  });

  it('answers a hostile document quickly', () => {
    const started = performance.now();
    // 100 000 attributes, 300 000 elements, a 2 MB text, deep nesting.
    const attributes = Array.from({ length: 100_000 }, (_, index) => `a${String(index)}="x"`).join(
      ' ',
    );
    expect(parseXml(`<a ${attributes}/>`).ok).toBe(true);
    expect(parseXml(`<r>${'<e/>'.repeat(300_000)}</r>`).ok).toBe(true);
    expect(parseXml(`<a>${'x'.repeat(2_000_000)}</a>`).ok).toBe(true);
    expect(parseXml('<a>'.repeat(200_000)).ok).toBe(false);
    expect(parseXml(`<a b="${'&amp;'.repeat(200_000)}"/>`).ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('writeXml', () => {
  it('writes elements, attributes and text, indented', () => {
    expect(
      write({
        shop: {
          '@_id': 7,
          name: 'A & B',
          item: [{ '@_n': '1', '#text': 'x' }, 'y', null],
          empty: {},
        },
      }),
    ).toBe(
      [
        '<shop id="7">',
        '  <name>A &amp; B</name>',
        '  <item n="1">x</item>',
        '  <item>y</item>',
        '  <item/>',
        '  <empty/>',
        '</shop>',
      ].join('\n'),
    );
  });

  it('indents with four spaces or a tab, or not at all', () => {
    const value = { a: { b: 'x', c: { d: 'y' } } };
    expect(write(value, { ...pretty, indent: 4 })).toBe(
      '<a>\n    <b>x</b>\n    <c>\n        <d>y</d>\n    </c>\n</a>',
    );
    expect(write(value, { ...pretty, indent: 'tab' })).toBe(
      '<a>\n\t<b>x</b>\n\t<c>\n\t\t<d>y</d>\n\t</c>\n</a>',
    );
    expect(write(value, compact)).toBe('<a><b>x</b><c><d>y</d></c></a>');
  });

  it('writes the declaration when asked', () => {
    const header = '<?xml version="1.0" encoding="UTF-8"?>';
    expect(write({ a: 'x' }, { ...pretty, declaration: true })).toBe(`${header}\n<a>x</a>`);
    expect(write({ a: 'x' }, { ...compact, declaration: true })).toBe(`${header}<a>x</a>`);
  });

  it('uses a single key as the root and wraps everything else', () => {
    expect(write({ a: 1 })).toBe('<a>1</a>');
    expect(write({ a: 1, b: 2 })).toBe('<root>\n  <a>1</a>\n  <b>2</b>\n</root>');
    expect(write({ a: [1, 2] })).toBe('<root>\n  <a>1</a>\n  <a>2</a>\n</root>');
    expect(write([1, 'x'])).toBe('<root>\n  <item>1</item>\n  <item>x</item>\n</root>');
    expect(write('text')).toBe('<root>text</root>');
    expect(write(null)).toBe('<root/>');
    expect(write(true)).toBe('<root>true</root>');
    expect(write({})).toBe('<root/>');
    expect(write({ '@_id': 1 })).toBe('<root id="1"/>');
    expect(write({ '#text': 'x' })).toBe('<root>x</root>');
    expect(write({ a: 1 }, { ...pretty, rootName: 'data' })).toBe('<a>1</a>');
    expect(write({ a: 1, b: 2 }, { ...compact, rootName: 'data' })).toBe(
      '<data><a>1</a><b>2</b></data>',
    );
  });

  it('puts the text of an element with children on a line of its own', () => {
    expect(write({ a: { '#text': 'hi', b: 'x' } })).toBe('<a>\n  hi\n  <b>x</b>\n</a>');
  });

  it('escapes text and attribute values', () => {
    expect(write({ a: { '@_v': 'a"b<c>&d\ne\tf\rg', '#text': '<&>' } }, compact)).toBe(
      '<a v="a&quot;b&lt;c&gt;&amp;d&#10;e&#9;f&#13;g">&lt;&amp;&gt;</a>',
    );
  });

  it('writes numbers and booleans as text, and null as an empty element', () => {
    expect(write({ a: { n: 1.5, t: true, f: false, z: 0, e: '', x: null } }, compact)).toBe(
      '<a><n>1.5</n><t>true</t><f>false</f><z>0</z><e/><x/></a>',
    );
  });

  it('refuses a key that is not an element name, with its path', () => {
    expect(writeFails({ a: { 'b c': 1 } })).toEqual({
      code: 'badName',
      path: '$.a["b c"]',
      found: 'b c',
    });
    expect(writeFails({ '1': 1, b: 2 })).toEqual({ code: 'badName', path: '$["1"]', found: '1' });
    expect(writeFails({ a: { '@_x y': 1 } })).toEqual({
      code: 'badName',
      path: '$.a["@_x y"]',
      found: 'x y',
    });
    expect(writeFails({ a: 1, b: 2 }, { ...pretty, rootName: 'not a name' })).toEqual({
      code: 'badName',
      path: '$',
      found: 'not a name',
    });
  });

  it('refuses what XML cannot hold', () => {
    expect(writeFails({ a: [[1]] })).toEqual({ code: 'nestedArray', path: '$.a[0]' });
    expect(writeFails({ a: [1, [2]] }, compact)).toEqual({ code: 'nestedArray', path: '$.a[1]' });
    expect(writeFails({ a: { '@_x': { y: 1 } } })).toEqual({
      code: 'attributeValue',
      path: '$.a["@_x"]',
    });
    expect(writeFails({ a: { '#text': [1] } })).toEqual({
      code: 'attributeValue',
      path: '$.a["#text"]',
    });
    expect(writeFails({ a: Infinity })).toEqual({
      code: 'notFinite',
      path: '$.a',
      found: 'Infinity',
    });
    expect(writeFails({ a: 'x\u{1}y' })).toEqual({
      code: 'badCharacter',
      path: '$.a',
      found: 'U+0001',
    });
    expect(writeFails({ a: { '@_v': 'x\u{b}' } })).toMatchObject({ code: 'badCharacter' });
  });

  it('refuses a document nested deeper than it reads', () => {
    let value: XmlSource = 'x';
    for (let level = 0; level < MAX_XML_DEPTH + 2; level += 1) {
      value = { a: value };
    }
    expect(writeFails(value, compact).code).toBe('tooDeep');
    let fitting: XmlSource = 'x';
    for (let level = 0; level < MAX_XML_DEPTH; level += 1) {
      fitting = { a: fitting };
    }
    expect(writeXml(fitting, compact).ok).toBe(true);
  });
});

/** A small deterministic generator (no extra dependency). */
function random(seed: number): () => number {
  let state = seed;
  return (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const NAMES = ['a', 'b', 'item', 'ns:x', 'é', 'long-name.1', '_u'];
const TEXTS = ['x', 'two words', '<&>"\'', 'ü 😀', 'line\nbreak', 'a  b'];

function generateText(next: () => number): string {
  return TEXTS[Math.floor(next() * TEXTS.length)] ?? 'x';
}

/** A value in the shape the reader produces, so that writing and reading it again gives it back. */
function generate(next: () => number, depth: number): XmlValue {
  if (depth > 3 || next() < 0.3) {
    return next() < 0.15 ? '' : generateText(next);
  }
  const result: Record<string, XmlValue> = {};
  for (const name of NAMES) {
    if (next() < 0.15) {
      setOwn(result, `@_${name}`, generateText(next));
    }
  }
  const children = NAMES.filter(() => next() < 0.35);
  for (const name of children) {
    if (next() < 0.35) {
      setOwn(
        result,
        name,
        Array.from({ length: 2 + Math.floor(next() * 2) }, () => generate(next, depth + 1)),
      );
    } else {
      setOwn(result, name, generate(next, depth + 1));
    }
  }
  if (children.length > 0 || Object.keys(result).length === 0 ? next() < 0.3 : next() < 0.5) {
    setOwn(result, '#text', generateText(next));
  }
  const keys = Object.keys(result);
  if (keys.length === 0) {
    setOwn(result, '@_id', generateText(next));
  }
  // An element with nothing but text reads back as that text.
  return keys.length === 1 && keys[0] === '#text' ? generateText(next) : result;
}

describe('property: writing and reading agree', () => {
  it('reads back what it wrote, with any indent', () => {
    const next = random(20261119);
    for (let round = 0; round < 300; round += 1) {
      const value: XmlObject = { root: generate(next, 0) };
      for (const indent of [0, 2, 'tab'] as const) {
        const text = write(value, { indent, rootName: 'document', declaration: round % 2 === 0 });
        const back = parseXml(text);
        expect(back.ok, text).toBe(true);
        if (back.ok) {
          expect(back.value, text).toEqual(value);
        }
      }
    }
  });

  it('never throws on damaged documents, and every error points inside the text', () => {
    const next = random(99);
    for (let round = 0; round < 500; round += 1) {
      const source = write({ root: generate(next, 0) }, pretty);
      const cut = Math.floor(next() * (source.length + 1));
      const damaged =
        next() < 0.5
          ? source.slice(0, cut)
          : `${source.slice(0, cut)}${'<>&;"\'/=![]-?'.charAt(Math.floor(next() * 13))}${source.slice(cut)}`;
      const result = parseXml(damaged);
      if (!result.ok) {
        expect(result.error.offset).toBeGreaterThanOrEqual(0);
        expect(result.error.offset).toBeLessThanOrEqual(damaged.length);
        expect(result.error.line).toBeGreaterThanOrEqual(1);
        expect(result.error.column).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe('agreement with the browser parser (jsdom)', () => {
  /** What the document is made of, the way the reader maps it: the oracle is the DOM. */
  function viaDom(element: Element): XmlValue {
    const attributes = [...element.attributes];
    const children = [...element.children];
    const text = [...element.childNodes]
      .filter((node) => node.nodeType === 3 || node.nodeType === 4)
      .map((node) => node.nodeValue ?? '');
    if (attributes.length === 0 && children.length === 0) {
      return text.join('');
    }
    const result: Record<string, XmlValue> = {};
    for (const attribute of attributes) {
      setOwn(result, `@_${attribute.name}`, attribute.value);
    }
    const groups = new Map<string, XmlValue[]>();
    for (const child of children) {
      groups.set(child.tagName, [...(groups.get(child.tagName) ?? []), viaDom(child)]);
    }
    for (const [name, group] of groups) {
      setOwn(result, name, group.length === 1 ? (group[0] ?? '') : group);
    }
    const own =
      children.length === 0
        ? text.join('')
        : text
            .map((piece) => piece.trim())
            .filter((piece) => piece !== '')
            .join(' ');
    if (own.trim() !== '') {
      setOwn(result, '#text', own);
    }
    return result;
  }

  const wellFormed = [
    '<a/>',
    '<a>x</a>',
    '<?xml version="1.0"?><r a="1" b=\'2\'><c>t</c><c>u</c><d/></r>',
    '<r>\n  <a>\n    <b>x &amp; y &lt; z &#65; &#x1F600;</b>\n  </a>\n</r>',
    '<r><![CDATA[<raw & text>]]><!-- c --><?pi x?></r>',
    '<p>Hello <b>big</b> world</p>',
    '<r a="x\ty\nz"/>',
    '<r>x\r\ny</r>',
    '<ns:r xmlns:ns="urn:example"><ns:c ns:a="1"/></ns:r>',
    '<日本語 属性="値">テキスト</日本語>',
    '<!DOCTYPE r SYSTEM "r.dtd"><r>x</r>',
  ];

  const malformed = [
    '<a>',
    '<a></b>',
    '<a b=1/>',
    '<a b="1" b="2"/>',
    '<a>&nbsp;</a>',
    '<a/><b/>',
    '<a>x ]]> y</a>',
    '<a b="<"/>',
    '<1a/>',
    '<a>&#0;</a>',
    '<a><!-- a -- b --></a>',
    'text<a/>',
    '<a/>text',
    '<a b="1"c="2"/>',
  ];

  it.each(wellFormed)('reads %j like the DOM does', (text) => {
    const dom = new DOMParser().parseFromString(text, 'application/xml');
    expect(dom.getElementsByTagName('parsererror')).toHaveLength(0);
    const root = dom.documentElement;
    expect(read(text)).toEqual({ [root.tagName]: viaDom(root) });
  });

  it.each(malformed)('refuses %j like the DOM does', (text) => {
    const dom = new DOMParser().parseFromString(text, 'application/xml');
    expect(dom.getElementsByTagName('parsererror').length).toBeGreaterThan(0);
    expect(parseXml(text).ok).toBe(false);
  });
});
