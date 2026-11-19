import { describe, expect, it } from 'vitest';
import { decodeText, encodeText, parseUrl, type EncodeMode } from '../../src/tools/url/url.ts';

function encoded(text: string, mode: EncodeMode): string {
  const result = encodeText(text, mode);
  if (!result.ok) {
    throw new Error('expected an encoding');
  }
  return result.text;
}

function decoded(text: string, mode: EncodeMode): string {
  const result = decodeText(text, mode);
  if (!result.ok) {
    throw new Error('expected a decoding');
  }
  return result.text;
}

describe('encodeText', () => {
  it("encodes a component: everything but letters, digits and - _ . ! ~ * ' ( )", () => {
    expect(encoded('a b&c=d/e?f#g', 'component')).toBe('a%20b%26c%3Dd%2Fe%3Ff%23g');
    expect(encoded("-_.!~*'()AZaz09", 'component')).toBe("-_.!~*'()AZaz09");
  });

  it('encodes non-ASCII as UTF-8', () => {
    expect(encoded('ä€', 'component')).toBe('%C3%A4%E2%82%AC');
    expect(encoded('😀', 'component')).toBe('%F0%9F%98%80');
  });

  it('keeps the structure of a whole URL', () => {
    expect(encoded('https://example.com/a b?x=1&y=ä#top', 'uri')).toBe(
      'https://example.com/a%20b?x=1&y=%C3%A4#top',
    );
  });

  it('makes form data: a space is +, and the characters a component leaves alone are encoded', () => {
    expect(encoded('a b+c', 'form')).toBe('a+b%2Bc');
    expect(encoded("!'()~*-._", 'form')).toBe('%21%27%28%29%7E*-._');
  });

  it('says a lone surrogate cannot be encoded, in every mode', () => {
    for (const mode of ['component', 'uri', 'form'] as const) {
      expect(encodeText('\ud800', mode)).toEqual({ ok: false, error: 'surrogate' });
      expect(encodeText('a\udc00b', mode)).toEqual({ ok: false, error: 'surrogate' });
    }
  });

  it('encodes the empty text to the empty text', () => {
    expect(encoded('', 'component')).toBe('');
  });
});

describe('decodeText', () => {
  it('decodes percent sequences as UTF-8', () => {
    expect(decoded('a%20b%26%C3%A4%E2%82%AC%F0%9F%98%80', 'component')).toBe('a b&ä€😀');
  });

  it('leaves + alone in component and URL mode, and turns it into a space in form mode', () => {
    expect(decoded('a+b%2Bc', 'component')).toBe('a+b+c');
    expect(decoded('a+b%2Bc', 'uri')).toBe('a+b%2Bc');
    expect(decoded('a+b%2Bc', 'form')).toBe('a b+c');
  });

  it('keeps reserved characters encoded in whole-URL mode, as decodeURI does', () => {
    expect(decoded('a%2Fb%3Fc%20d', 'uri')).toBe('a%2Fb%3Fc d');
    expect(decoded('a%2Fb%3Fc%20d', 'component')).toBe('a/b?c d');
  });

  it('reports a % that is not followed by two hex digits, with its position', () => {
    expect(decodeText('abc%', 'component')).toEqual({ ok: false, error: 'malformed', index: 3 });
    expect(decodeText('%4', 'component')).toEqual({ ok: false, error: 'malformed', index: 0 });
    expect(decodeText('100%zz', 'component')).toEqual({ ok: false, error: 'malformed', index: 3 });
    expect(decodeText('%%41', 'component')).toEqual({ ok: false, error: 'malformed', index: 0 });
  });

  it('reports a run of sequences that is not valid UTF-8, at the start of the run', () => {
    expect(decodeText('ok %C3 x', 'component')).toEqual({
      ok: false,
      error: 'malformed',
      index: 3,
    });
    expect(decodeText('%FF', 'uri')).toEqual({ ok: false, error: 'malformed', index: 0 });
    expect(decodeText('a%E2%82', 'form')).toEqual({ ok: false, error: 'malformed', index: 1 });
  });

  it('accepts hex digits in any case and the empty text', () => {
    expect(decoded('%c3%a4%C3%A4', 'component')).toBe('ää');
    expect(decoded('', 'component')).toBe('');
  });

  it('round-trips every mode (property over generated texts)', () => {
    let state = 0xc0ffee;
    const next = (): number => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state;
    };
    const pool = ['a', 'Z', '7', ' ', '+', '%', '&', '=', '/', '?', '#', 'ä', '€', '😀', '~', "'"];
    for (let round = 0; round < 300; round += 1) {
      let text = '';
      for (let index = 0; index < next() % 20; index += 1) {
        text += pool[next() % pool.length] ?? '';
      }
      for (const mode of ['component', 'form'] as const) {
        expect(decoded(encoded(text, mode), mode), `${mode}: ${text}`).toBe(text);
      }
      // `+` and `%` that were encoded come back as they were; whole-URL mode keeps reserved
      // characters, so only text without them round-trips there.
      if (!/[#&=/?+]/.test(text)) {
        expect(decoded(encoded(text, 'uri'), 'uri')).toBe(text);
      }
    }
  });
});

describe('parseUrl', () => {
  it('splits a URL into its parts', () => {
    const result = parseUrl('https://user:secret@Example.com:8443/a%20b/c?x=1&y=two+words&x=3#top');
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) {
      return;
    }
    expect(result.url).toMatchObject({
      href: 'https://user:secret@example.com:8443/a%20b/c?x=1&y=two+words&x=3#top',
      protocol: 'https:',
      username: 'user',
      password: 'secret',
      hostname: 'example.com',
      port: '8443',
      pathname: '/a%20b/c',
      search: '?x=1&y=two+words&x=3',
      hash: '#top',
      origin: 'https://example.com:8443',
    });
    expect(result.url.params).toEqual([
      { name: 'x', value: '1' },
      { name: 'y', value: 'two words' },
      { name: 'x', value: '3' },
    ]);
  });

  it('leaves out the default port and writes the empty path as /', () => {
    const result = parseUrl('https://example.com:443');
    expect(result.ok && result.url.port).toBe('');
    expect(result.ok && result.url.href).toBe('https://example.com/');
  });

  it('shows an international host name in its xn-- form', () => {
    const result = parseUrl('https://bücher.example/');
    expect(result.ok && result.url.hostname).toBe('xn--bcher-kva.example');
  });

  it('reads a URL without an authority and without an origin', () => {
    const mail = parseUrl('mailto:someone@example.com?subject=Hi%20there');
    expect(mail.ok && mail.url.protocol).toBe('mailto:');
    expect(mail.ok && mail.url.origin).toBe('null');
    expect(mail.ok && mail.url.params).toEqual([{ name: 'subject', value: 'Hi there' }]);
  });

  it('parses a script URL without running anything', () => {
    const result = parseUrl('javascript:alert(1)');
    expect(result.ok && result.url.protocol).toBe('javascript:');
  });

  it('ignores whitespace around the text', () => {
    expect(parseUrl('  https://example.com/  ').ok).toBe(true);
  });

  it('says what is wrong with empty text, a relative URL and plain words', () => {
    expect(parseUrl('')).toEqual({ ok: false, error: 'empty' });
    expect(parseUrl('   ')).toEqual({ ok: false, error: 'empty' });
    expect(parseUrl('/just/a/path?x=1')).toEqual({ ok: false, error: 'invalid' });
    expect(parseUrl('example.com/path')).toEqual({ ok: false, error: 'invalid' });
    expect(parseUrl('http://')).toEqual({ ok: false, error: 'invalid' });
    expect(parseUrl('http://exa mple.com')).toEqual({ ok: false, error: 'invalid' });
  });
});
