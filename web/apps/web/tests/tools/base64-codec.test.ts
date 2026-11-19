import { describe, expect, it } from 'vitest';
import {
  asText,
  dataUri,
  decodeBase64,
  decodedFileName,
  downloadType,
  encodeBytes,
  hexHead,
  isMediaType,
  wrapLines,
  type DecodeError,
  type EncodeOptions,
} from '../../src/tools/base64/codec.ts';

const plain: EncodeOptions = { urlSafe: false, padding: true, lineLength: 0 };

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function decoded(text: string): Uint8Array {
  const result = decodeBase64(text);
  if (!result.ok) {
    throw new Error(`not decoded: ${JSON.stringify(result.error)}`);
  }
  return result.bytes;
}

function problem(text: string): DecodeError {
  const result = decodeBase64(text);
  if (result.ok) {
    throw new Error('decoded without an error');
  }
  return result.error;
}

/** A deterministic generator (no extra dependency). */
function random(seed: number): () => number {
  let state = seed;
  return (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('encodeBytes: the RFC 4648 test vectors', () => {
  it.each([
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='],
    ['foobar', 'Zm9vYmFy'],
  ])('encodes %j as %s', (text, expected) => {
    expect(encodeBytes(new TextEncoder().encode(text), plain)).toBe(expected);
  });

  it('leaves the padding out when asked', () => {
    const options = { ...plain, padding: false };
    expect(encodeBytes(new TextEncoder().encode('f'), options)).toBe('Zg');
    expect(encodeBytes(new TextEncoder().encode('fo'), options)).toBe('Zm8');
    expect(encodeBytes(new TextEncoder().encode('foo'), options)).toBe('Zm9v');
  });

  it('uses the other alphabet for 62 and 63 when asked', () => {
    const data = bytes(0xfb, 0xff, 0xfe);
    expect(encodeBytes(data, plain)).toBe('+//+');
    expect(encodeBytes(data, { ...plain, urlSafe: true })).toBe('-__-');
  });

  it('writes a line break after every 76 or 64 characters', () => {
    const data = new Uint8Array(100).fill(65);
    const text = encodeBytes(data, { ...plain, lineLength: 76 });
    const lines = text.split(String.fromCharCode(10));
    expect(lines.map((line) => line.length)).toEqual([76, 60]);
    expect(
      encodeBytes(data, { ...plain, lineLength: 64 })
        .split(String.fromCharCode(10))
        .map((line) => line.length),
    ).toEqual([64, 64, 8]);
    expect(wrapLines('abcd', 0)).toBe('abcd');
    expect(wrapLines('abcd', 2)).toBe('ab' + String.fromCharCode(10) + 'cd');
    expect(wrapLines('', 76)).toBe('');
  });

  it('builds a data URI', () => {
    expect(dataUri('text/plain', 'Zm9v')).toBe('data:text/plain;base64,Zm9v');
  });

  it('agrees with Node on random data of every length', () => {
    const next = random(1);
    for (let round = 0; round < 300; round += 1) {
      const data = Uint8Array.from({ length: round % 40 }, () => Math.floor(next() * 256));
      const expected = Buffer.from(data).toString('base64');
      expect(encodeBytes(data, plain)).toBe(expected);
      expect(encodeBytes(data, { ...plain, padding: false })).toBe(expected.replace(/=+$/, ''));
      expect(encodeBytes(data, { ...plain, urlSafe: true })).toBe(
        expected.replaceAll('+', '-').replaceAll('/', '_'),
      );
      if (data.length > 0) {
        expect(Buffer.from(decoded(expected)).equals(Buffer.from(data))).toBe(true);
      }
    }
  });
});

describe('isMediaType', () => {
  it.each([
    'text/plain',
    'image/png',
    'application/vnd.api+json',
    'text/plain;charset=utf-8',
    'text/html; x=y'.replace(' ', ''),
  ])('accepts %s', (type) => {
    expect(isMediaType(type)).toBe(true);
  });

  it.each([
    '',
    'text',
    '/plain',
    'text/',
    'text/plain;',
    'text/plain;charset',
    'a b/c',
    'text/plain,x',
    'text/pl ain',
    'text/plain;a=b c',
  ])('refuses %j', (type) => {
    expect(isMediaType(type)).toBe(false);
  });
});

describe('decodeBase64', () => {
  it('decodes the test vectors, with or without padding', () => {
    expect(new TextDecoder().decode(decoded('Zm9vYmE='))).toBe('fooba');
    expect(new TextDecoder().decode(decoded('Zm9vYmE'))).toBe('fooba');
    expect(new TextDecoder().decode(decoded('Zg'))).toBe('f');
    expect(new TextDecoder().decode(decoded('Zg=='))).toBe('f');
    expect(decoded('Zm9v')).toEqual(bytes(102, 111, 111));
  });

  it('reads both alphabets', () => {
    expect(decoded('+//+')).toEqual(bytes(0xfb, 0xff, 0xfe));
    expect(decoded('-__-')).toEqual(bytes(0xfb, 0xff, 0xfe));
  });

  it('ignores spaces, tabs and every kind of line break', () => {
    expect(new TextDecoder().decode(decoded('Zm9v\r\nYmFy\n Zm9v\tYg ==\r'))).toBe('foobarfoob');
  });

  it('understands a data URI and reports its media type', () => {
    const result = decodeBase64('data:text/plain;charset=utf-8;base64,Zm9v');
    expect(result).toMatchObject({ ok: true, mediaType: 'text/plain;charset=utf-8' });
    expect(decodeBase64('  DATA:image/png;BASE64,Zm9v')).toMatchObject({
      ok: true,
      mediaType: 'image/png',
    });
    const bare = decodeBase64('data:;base64,Zm9v');
    expect(bare).toMatchObject({ ok: true });
    expect('mediaType' in bare).toBe(false);
    expect(decodeBase64('Zm9v')).not.toHaveProperty('mediaType');
  });

  it('refuses a data URI that is not Base64', () => {
    expect(problem('data:text/plain,hello')).toMatchObject({
      code: 'notBase64DataUri',
      offset: 0,
      line: 1,
      column: 1,
    });
  });

  it('says there is nothing to decode', () => {
    expect(problem('')).toMatchObject({ code: 'empty' });
    expect(problem(' \n ')).toMatchObject({ code: 'empty' });
    expect(problem('data:text/plain;base64,')).toMatchObject({ code: 'empty' });
  });

  it('names the character that is not Base64, with line and column', () => {
    expect(problem('Zm9v\nYm!y')).toEqual({
      code: 'invalidChar',
      offset: 7,
      line: 2,
      column: 3,
      found: '!',
    });
    expect(problem('Zm9é')).toMatchObject({ code: 'invalidChar', offset: 3, found: 'é' });
    expect(problem('Zm9\u{1f600}')).toMatchObject({
      code: 'invalidChar',
      offset: 3,
      found: '\u{1f600}',
    });
    expect(problem('Zm9v\u{0}')).toMatchObject({ code: 'invalidChar', found: '\u{0}' });
  });

  it('refuses a length that no Base64 text has', () => {
    for (const text of ['A', 'Zm9vY', 'Zm9vYmFyZ']) {
      expect(problem(text)).toMatchObject({ code: 'badLength', offset: text.length });
    }
  });

  it('refuses padding in the wrong place', () => {
    expect(problem('Zg=x')).toMatchObject({ code: 'badPadding', offset: 2 });
    expect(problem('Z=g=')).toMatchObject({ code: 'badPadding', offset: 1 });
    expect(problem('Zg===')).toMatchObject({ code: 'badPadding', offset: 2 });
    expect(problem('Zm9vY=')).toMatchObject({ code: 'badPadding', offset: 5 });
    expect(problem('Zm9v=')).toMatchObject({ code: 'badPadding' });
    expect(problem('====')).toMatchObject({ code: 'badPadding', offset: 0 });
    expect(problem('=')).toMatchObject({ code: 'badPadding' });
  });

  it('refuses a text that mixes the two alphabets, at the first character of the other one', () => {
    expect(problem('+/-_')).toEqual({
      code: 'mixedAlphabet',
      offset: 2,
      line: 1,
      column: 3,
      found: '-',
    });
    expect(problem('-_+/')).toMatchObject({ code: 'mixedAlphabet', offset: 2, found: '+' });
  });

  it('never throws, whatever the text', () => {
    const next = random(9);
    const alphabet = 'AZaz09+/-_= \n\t!é';
    for (let round = 0; round < 500; round += 1) {
      const text = Array.from({ length: Math.floor(next() * 40) }, () =>
        alphabet.charAt(Math.floor(next() * alphabet.length)),
      ).join('');
      const result = decodeBase64(text);
      if (!result.ok) {
        expect(result.error.offset).toBeGreaterThanOrEqual(0);
        expect(result.error.offset).toBeLessThanOrEqual(text.length);
      }
    }
  });
});

describe('asText and hexHead', () => {
  it('gives text for valid UTF-8 and nothing for binary data', () => {
    expect(asText(new TextEncoder().encode('héllo\n\t\r wörld 😀'))).toBe('héllo\n\t\r wörld 😀');
    expect(asText(bytes(0xff, 0xfe))).toBeUndefined();
    expect(asText(bytes(104, 0, 105))).toBeUndefined();
    expect(asText(bytes(104, 7, 105))).toBeUndefined();
    expect(asText(bytes(104, 14, 105))).toBeUndefined();
    expect(asText(bytes(104, 31, 105))).toBeUndefined();
    expect(asText(bytes(104, 32, 105))).toBe('h i');
    expect(asText(new Uint8Array())).toBe('');
  });

  it('shows the first bytes in hexadecimal', () => {
    expect(hexHead(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(
      '89 50 4e 47 0d 0a 1a 0a',
    );
    expect(hexHead(new Uint8Array(40), 3)).toBe('00 00 00');
    expect(hexHead(new Uint8Array(0))).toBe('');
  });
});

describe('decodedFileName', () => {
  it('names the file by the media type, when it is a well-known one', () => {
    expect(decodedFileName('image/png', false)).toBe('decoded.png');
    expect(decodedFileName('IMAGE/JPEG', false)).toBe('decoded.jpg');
    expect(decodedFileName('text/plain;charset=utf-8', true)).toBe('decoded.txt');
    expect(decodedFileName('application/pdf', false)).toBe('decoded.pdf');
  });

  it('says txt for text and bin for anything else', () => {
    expect(decodedFileName(undefined, true)).toBe('decoded.txt');
    expect(decodedFileName(undefined, false)).toBe('decoded.bin');
    expect(decodedFileName('application/x-unknown', false)).toBe('decoded.bin');
    expect(decodedFileName('application/x-unknown', true)).toBe('decoded.txt');
    expect(decodedFileName('', false)).toBe('decoded.bin');
  });
});

describe('what a decoded file may be called and typed', () => {
  it('never saves decoded data as a type a browser would run or render', () => {
    for (const type of [
      'text/html',
      'TEXT/HTML;charset=utf-8',
      'image/svg+xml',
      'application/xhtml+xml',
      'text/xml',
      'application/xml',
      'application/javascript',
      'text/javascript',
    ]) {
      expect(downloadType(type, false)).toBe('application/octet-stream');
      expect(downloadType(type, true)).toBe('text/plain');
      expect(decodedFileName(type, false)).toBe('decoded.bin');
      expect(decodedFileName(type, true)).toBe('decoded.txt');
    }
  });

  it('keeps a harmless type as the data URI named it, and falls back without one', () => {
    expect(downloadType('image/png', false)).toBe('image/png');
    expect(downloadType('text/plain;charset=utf-8', true)).toBe('text/plain;charset=utf-8');
    expect(downloadType(undefined, true)).toBe('text/plain');
    expect(downloadType(undefined, false)).toBe('application/octet-stream');
    expect(downloadType('', false)).toBe('application/octet-stream');
  });
});
