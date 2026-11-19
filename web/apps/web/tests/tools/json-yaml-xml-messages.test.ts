import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import type { ConvertError } from '../../src/tools/json-yaml-xml/convert.ts';
import { convertErrorText } from '../../src/tools/json-yaml-xml/messages.ts';

afterEach(() => {
  i18n.setLocale('en');
});

function read(
  format: ConvertError['format'],
  code: string,
  rest: Partial<ConvertError> = {},
): ConvertError {
  return { where: 'read', format, code, ...rest };
}

const open = '“';
const close = '”';

describe('convertErrorText: JSON', () => {
  it.each<[string, Partial<ConvertError>, string]>([
    ['empty', {}, 'There is no JSON in the text.'],
    [
      'unexpectedEnd',
      { expected: 'commaOrBracket' },
      'The text ends too early. Expected a comma or the closing bracket.',
    ],
    [
      'unexpectedChar',
      { found: '}', expected: 'value' },
      `Unexpected ${open}}${close}. Expected a value.`,
    ],
    ['badNumber', { found: '01' }, `${open}01${close} is not a valid number.`],
    ['badEscape', { found: '\\q' }, `${open}\\q${close} is not a valid escape in a string.`],
    [
      'badUnicode',
      {},
      'A unicode escape in a string needs four hexadecimal digits (an escape with x needs two).',
    ],
    [
      'controlChar',
      { found: 'U+000A' },
      'A string contains the control character U+000A. Write it as an escape instead.',
    ],
    ['unterminatedString', {}, 'A string is not closed.'],
    ['unterminatedComment', {}, 'A comment is not closed.'],
    ['tooDeep', { max: 512 }, 'The nesting is deeper than 512 levels.'],
    ['notRepresentable', { found: 'NaN' }, `${open}NaN${close} cannot be written in JSON.`],
  ])('says %s', (code, rest, text) => {
    expect(convertErrorText(read('json', code, rest))).toBe(`JSON input: ${text}`);
  });

  it('adds the position when there is one', () => {
    expect(convertErrorText(read('json', 'unterminatedString', { line: 2, column: 5 }))).toBe(
      'JSON input: A string is not closed. (line 2, column 5)',
    );
  });
});

describe('convertErrorText: YAML', () => {
  it('says what it knows, and passes the reader its own message on', () => {
    expect(convertErrorText(read('yaml', 'empty'))).toBe(
      'YAML input: There is no YAML in the text.',
    );
    expect(convertErrorText(read('yaml', 'tooDeep', { max: 512 }))).toBe(
      'YAML input: The nesting is deeper than 512 levels.',
    );
    expect(convertErrorText(read('yaml', 'aliasLimit', { max: 100 }))).toContain('(a YAML bomb)');
    expect(
      convertErrorText(
        read('yaml', 'BAD_INDENT', { detail: 'Bad indentation', line: 3, column: 2 }),
      ),
    ).toBe('YAML input: Bad indentation (line 3, column 2)');
    expect(convertErrorText(read('yaml', 'WEIRD'))).toBe('YAML input: WEIRD');
  });
});

describe('convertErrorText: XML', () => {
  it.each<[string, Partial<ConvertError>, string]>([
    ['empty', {}, 'There is no XML in the text.'],
    ['noRoot', {}, 'The document has no root element.'],
    ['multipleRoots', {}, 'There is more than one root element; there must be exactly one.'],
    ['textOutsideRoot', {}, 'There is text outside the root element.'],
    ['unexpectedEnd', { found: 'a' }, 'The element <a> is never closed.'],
    ['unterminated', {}, 'A tag, comment or section starts here but never ends.'],
    [
      'mismatchedTag',
      { found: 'a', expected: 'b' },
      'The closing tag <a> does not match the open element <b>.',
    ],
    ['mismatchedTag', { found: 'a' }, 'The closing tag <a> has no opening tag.'],
    ['badName', { found: '1' }, 'A valid name was expected here, not 1.'],
    ['badName', {}, 'A valid name was expected here, but the text ends.'],
    [
      'badAttribute',
      { found: 'b' },
      'Not a valid attribute near b. Attributes look like name="value" and are separated by spaces.',
    ],
    ['duplicateAttribute', { found: 'id' }, 'The attribute id appears twice on one element.'],
    [
      'badReference',
      { found: '&nbsp;' },
      '&nbsp; is not a known entity. Only the five predefined ones (lt, gt, amp, quot, apos) and character references such as &#65; are supported.',
    ],
    ['badCharacter', { found: '\u0001' }, 'U+0001 is not allowed here.'],
    ['badCharacter', { found: ']]>' }, `${open}]]>${close} is not allowed here.`],
    ['tooDeep', { max: 512 }, 'The nesting is deeper than 512 levels.'],
  ])('says %s', (code, rest, text) => {
    expect(convertErrorText(read('xml', code, rest))).toBe(`XML input: ${text}`);
  });

  it('explains why it refuses a DOCTYPE with entities', () => {
    expect(convertErrorText(read('xml', 'dtd', { line: 2, column: 1 }))).toContain(
      'A DOCTYPE with an internal subset (entity declarations) is not supported.',
    );
  });

  it('falls back to a general sentence for a code it does not know', () => {
    expect(convertErrorText(read('xml', 'somethingNew'))).toBe(
      'XML input: A tag, comment or section starts here but never ends.',
    );
  });
});

describe('convertErrorText: what cannot be written, and limits', () => {
  it.each<[ConvertError, string]>([
    [
      { where: 'write', format: 'xml', code: 'badName', path: '$.a', found: 'b c' },
      `This cannot be written as XML: ${open}b c${close} is not a valid XML element or attribute name (at $.a). Rename the key.`,
    ],
    [
      { where: 'write', format: 'xml', code: 'badCharacter', path: '$.a', found: 'U+0001' },
      'This cannot be written as XML: U+0001 cannot be written in XML (at $.a).',
    ],
    [
      { where: 'write', format: 'xml', code: 'nestedArray', path: '$.a[0]' },
      'This cannot be written as XML: A list inside a list cannot be written as XML (at $.a[0]).',
    ],
    [
      { where: 'write', format: 'xml', code: 'attributeValue', path: '$.a' },
      'This cannot be written as XML: An attribute (a key starting with @_) or #text must be plain text, not a list or an object (at $.a).',
    ],
    [
      { where: 'write', format: 'xml', code: 'tooDeep', path: '$.a', max: 512 },
      'This cannot be written as XML: The nesting is deeper than 512 levels (at $.a).',
    ],
    [
      { where: 'write', format: 'xml', code: 'notFinite', path: '$.n', found: 'Infinity' },
      'This cannot be written as XML: The number Infinity cannot be written in JSON or XML (at $.n).',
    ],
    [
      { where: 'write', format: 'json', code: 'notFinite', path: '$.n', found: 'NaN' },
      'This cannot be written as JSON: The number NaN cannot be written in JSON or XML (at $.n).',
    ],
    [
      { where: 'write', format: 'json', code: 'notData', path: '$.d', found: 'bigint' },
      'This cannot be written as JSON: The value at $.d is not plain data (bigint).',
    ],
    [
      { where: 'write', format: 'json', code: 'unknown' },
      'This cannot be written as JSON: The value at $ is not plain data ().',
    ],
  ])('says it for %j', (error, text) => {
    expect(convertErrorText(error)).toBe(text);
  });

  it.each<[string, string]>([
    ['inputTooLarge', 'The text is longer than 5,000,000 characters.'],
    ['tooDeep', 'The document is nested deeper than 5,000,000 levels.'],
    [
      'tooManyValues',
      'The document has more than 5,000,000 values once shared values are expanded.',
    ],
    ['tooLarge', 'The result would be longer than 5,000,000 characters.'],
    ['other', 'The result would be longer than 5,000,000 characters.'],
  ])('says the limit %s without naming a format', (code, text) => {
    expect(convertErrorText({ where: 'limit', format: 'json', code, max: 5_000_000 })).toBe(text);
  });
});

describe('convertErrorText: German', () => {
  it('speaks German and puts the position the German way', () => {
    i18n.setLocale('de');
    expect(
      convertErrorText(
        read('json', 'unexpectedChar', { found: '}', expected: 'value', line: 1, column: 5 }),
      ),
    ).toBe(
      `Eingabe als JSON: Unerwartet: ${open}}${close}. Erwartet wurde ein Wert. (Zeile 1, Spalte 5)`,
    );
    expect(
      convertErrorText({ where: 'write', format: 'xml', code: 'nestedArray', path: '$.a' }),
    ).toBe(
      'Das lässt sich nicht als XML schreiben: Eine Liste in einer Liste lässt sich nicht als XML schreiben (bei $.a).',
    );
    expect(convertErrorText({ where: 'limit', format: 'json', code: 'tooLarge', max: 1000 })).toBe(
      'Das Ergebnis wäre länger als 1.000 Zeichen.',
    );
  });
});
