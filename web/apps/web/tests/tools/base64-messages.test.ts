import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import type { DecodeError, DecodeErrorCode } from '../../src/tools/base64/codec.ts';
import { decodeErrorText, formatSize } from '../../src/tools/base64/messages.ts';
import {
  featureList,
  jsonErrorText,
  jsonProblemText,
  shown,
} from '../../src/tools/json-formatter/messages.ts';

afterEach(() => {
  i18n.setLocale('en');
});

function failure(code: DecodeErrorCode, found?: string): DecodeError {
  return { code, offset: 4, line: 2, column: 3, ...(found === undefined ? {} : { found }) };
}

describe('decodeErrorText', () => {
  it.each<[DecodeErrorCode, string | undefined, string]>([
    ['invalidChar', '!', '“!” is not a Base64 character. (line 2, column 3)'],
    ['invalidChar', '\u0007', 'U+0007 is not a Base64 character. (line 2, column 3)'],
    [
      'badLength',
      undefined,
      'The length is not valid for Base64: a text cannot be one character more than a multiple of four. (line 2, column 3)',
    ],
    [
      'badPadding',
      undefined,
      'The = padding is in the wrong place: it may only close the text, at most two of them. (line 2, column 3)',
    ],
    [
      'mixedAlphabet',
      '-',
      '“-” belongs to the other alphabet. A text uses either + and / or - and _, not both. (line 2, column 3)',
    ],
    [
      'notBase64DataUri',
      undefined,
      'This data URI is not Base64 (it has no ;base64). Only Base64 data URIs are decoded here. (line 2, column 3)',
    ],
  ])('says %s', (code, found, text) => {
    expect(decodeErrorText(failure(code, found))).toBe(text);
  });

  it('says that there is nothing to decode without a position', () => {
    expect(decodeErrorText(failure('empty'))).toBe('There is nothing to decode.');
  });

  it('speaks German', () => {
    i18n.setLocale('de');
    expect(decodeErrorText(failure('invalidChar', '!'))).toBe(
      '“!” ist kein Base64-Zeichen. (Zeile 2, Spalte 3)',
    );
  });
});

describe('formatSize', () => {
  it('writes a size the way people read it', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(999)).toBe('999 B');
    expect(formatSize(1000)).toBe('1 kB');
    expect(formatSize(1536)).toBe('1.5 kB');
    expect(formatSize(5_000_000)).toBe('5 MB');
    expect(formatSize(48 * 1024 * 1024)).toBe('50.3 MB');
    expect(formatSize(3e9)).toBe('3 GB');
    expect(formatSize(5e12)).toBe('5,000 GB');
    i18n.setLocale('de');
    expect(formatSize(1536)).toBe('1,5 kB');
  });
});

describe('JSON messages', () => {
  it('quotes a character and leaves a code point as it is', () => {
    expect(shown('x')).toBe('“x”');
    expect(shown('U+000A')).toBe('U+000A');
  });

  it('words an error with and without a position, and fills what is missing', () => {
    expect(jsonProblemText({ code: 'unexpectedChar' })).toBe('Unexpected “”. Expected a value.');
    expect(jsonProblemText({ code: 'feature', feature: 'trailingComma' })).toBe(
      'Strict JSON does not allow trailing commas.',
    );
    expect(jsonProblemText({ code: 'tooDeep', max: 1234 })).toBe(
      'The nesting is deeper than 1,234 levels.',
    );
    expect(jsonProblemText({ code: 'tooDeep' })).toBe('The nesting is deeper than 0 levels.');
    expect(jsonErrorText({ code: 'unterminatedString', line: 3, column: 9 })).toBe(
      'A string is not closed. (line 3, column 9)',
    );
  });

  it('lists features in the language of the page', () => {
    expect(featureList(['comment'])).toBe('comments');
    expect(featureList(['comment', 'number'])).toBe(
      'comments and JSON5 numbers (such as +1, .5 or 0x1F)',
    );
    i18n.setLocale('de');
    expect(featureList(['comment', 'trailingComma', 'whitespace'])).toBe(
      'Kommentare, Kommas am Ende und ungewöhnliche Leerzeichen',
    );
  });
});
