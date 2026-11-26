import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_KEY_LENGTH,
  MAX_TOKEN_LENGTH,
  decodeBase64Url,
  decodeToken,
  readPem,
  timeClaims,
  verifyToken,
  type DecodedToken,
} from '../../src/tools/jwt/jwt.ts';
import { b64url, ecKeys, ecToken, hmacToken, rsaKeys, rsaToken } from './jwt-helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

function decode(token: string): DecodedToken {
  const result = decodeToken(token);
  if (!result.ok) {
    throw new Error(`expected a token, got ${result.error}`);
  }
  return result.token;
}

const check = (token: string, key: string, base64 = false): ReturnType<typeof verifyToken> =>
  verifyToken(decode(token), key, base64);

describe('decodeBase64Url without padding', () => {
  it('reads every length from 0 to 40 bytes the way Buffer does', () => {
    for (let length = 0; length <= 40; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 53 + length) & 255);
      const text = Buffer.from(bytes).toString('base64url');
      expect([...(decodeBase64Url(text) ?? [])], String(length)).toEqual([...bytes]);
    }
  });

  it('refuses a length of 1 modulo 4 and anything outside the alphabet', () => {
    for (const text of ['A', 'AAAAA', 'AAAAAAAAA', 'A+A', 'A/A', 'A=', 'A A', 'é', 'A\n']) {
      expect(decodeBase64Url(text), JSON.stringify(text)).toBeUndefined();
    }
    expect(decodeBase64Url('')).toEqual(new Uint8Array(0));
  });
});

describe('decodeToken: sizes and shape', () => {
  it('reads text of exactly the longest size as text and refuses one character more as too long', () => {
    expect(decodeToken('a'.repeat(MAX_TOKEN_LENGTH))).toEqual({ ok: false, error: 'parts' });
    expect(decodeToken('a'.repeat(MAX_TOKEN_LENGTH + 1))).toEqual({ ok: false, error: 'too-long' });
  });

  it('refuses a token whose bytes are not UTF-8, in either part', () => {
    const bad = b64url(Uint8Array.from([0xff, 0xfe]));
    const good = b64url('{"alg":"HS256"}');
    expect(decodeToken(`${bad}.${good}.x`)).toEqual({ ok: false, error: 'utf8' });
    expect(decodeToken(`${good}.${bad}.x`)).toEqual({ ok: false, error: 'utf8' });
    expect(decodeToken(`${good}.${good}.x`)).toMatchObject({ ok: true });
  });
});

describe('timeClaims: what is a time', () => {
  const claim = (value: unknown): { claims: number; problems: number } => {
    const result = timeClaims({ exp: value }, 0);
    return { claims: result.claims.length, problems: result.problems.length };
  };

  it('takes a finite number of seconds that a date can hold, at both edges', () => {
    expect(claim(0)).toEqual({ claims: 1, problems: 0 });
    expect(claim(1.5)).toEqual({ claims: 1, problems: 0 });
    expect(claim(8.64e12)).toEqual({ claims: 1, problems: 0 });
    expect(claim(-8.64e12)).toEqual({ claims: 1, problems: 0 });
  });

  it('reports everything else as a problem and not as a time', () => {
    for (const value of [
      8.64e12 + 1,
      -8.64e12 - 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '5',
      null,
      true,
      [],
      {},
    ]) {
      expect(claim(value), JSON.stringify(value)).toEqual({ claims: 0, problems: 1 });
    }
  });
});

describe('readPem', () => {
  const block = (label: string, body = 'AQID'): string =>
    `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;

  it('wants the text to be one block from its first to its last character, white space around it aside', () => {
    expect(readPem(block('PUBLIC KEY'))?.label).toBe('PUBLIC KEY');
    expect(readPem(`\n  ${block('PUBLIC KEY')}  \n`)?.label).toBe('PUBLIC KEY');
    for (const text of [
      `x${block('PUBLIC KEY')}`,
      `${block('PUBLIC KEY')}x`,
      '-----BEGIN PUBLIC KEY',
      '-----BEGIN PUBLIC KEY-----',
      '-----BEGIN PUBLIC KEY-----\nAQID',
      '-----BEGIN PUBLIC KEY-----\nAQID\n-----END OTHER KEY-----',
      '-----BEGIN-----\nAQID\n-----END-----',
      '----BEGIN PUBLIC KEY-----\nAQID\n-----END PUBLIC KEY-----',
      // Eleven characters, then a footer without a label: only the opening decides that this is no block.
      'zzzzzzzzzzz-----END -----',
      '-----BEGIN -----END -----x',
      '',
    ]) {
      expect(readPem(text), JSON.stringify(text)).toBeUndefined();
    }
  });
});

/** The first argument that `crypto.subtle.importKey` got for each call. */
function spyOnImport(): { readonly extractable: () => unknown[] } {
  const spy = vi.spyOn(crypto.subtle, 'importKey');
  return { extractable: () => spy.mock.calls.map((call) => call[3]) };
}

describe('verifyToken: keys are imported as not extractable', () => {
  it('for a shared secret as text, as a JWK and as Base64', async () => {
    const spy = spyOnImport();
    const secret = 'a-secret-of-some-length';
    const token = hmacToken('HS256', secret, { sub: 'x' });
    await check(token, secret);
    await check(token, JSON.stringify({ kty: 'oct', k: b64url(secret) }));
    await check(token, Buffer.from(secret).toString('base64'), true);
    expect(spy.extractable()).toEqual([false, false, false]);
  });

  it('for a public key as PEM and as JWK', async () => {
    const spy = spyOnImport();
    const pair = rsaKeys();
    const token = rsaToken('RS256', pair, { sub: 'x' });
    expect(await check(token, pair.publicPem)).toEqual({ ok: true, valid: true });
    expect(await check(token, pair.publicJwk)).toEqual({ ok: true, valid: true });
    expect(spy.extractable()).toEqual([false, false]);
  });
});

describe('verifyToken: the key text', () => {
  const payload = { sub: 'x' };

  it('may have white space around a PEM block and around a JWK', async () => {
    const pair = ecKeys('P-256');
    const token = ecToken('ES256', pair, payload);
    expect(await check(token, `\n  ${pair.publicPem}\n\n`)).toEqual({ ok: true, valid: true });
    expect(await check(token, `  ${pair.publicJwk}\n`)).toEqual({ ok: true, valid: true });
    const secret = 'shared-secret';
    const jwk = JSON.stringify({ kty: 'oct', k: b64url(secret) });
    expect(await check(hmacToken('HS256', secret, payload), `\n ${jwk} \n`)).toEqual({
      ok: true,
      valid: true,
    });
    // A shared secret as text is taken exactly as it is, white space included.
    expect(await check(hmacToken('HS256', ` ${secret} `, payload), ` ${secret} `)).toEqual({
      ok: true,
      valid: true,
    });
  });

  it('is limited to exactly MAX_KEY_LENGTH characters', async () => {
    const secret = 'k'.repeat(MAX_KEY_LENGTH);
    const token = hmacToken('HS256', secret, payload);
    expect(await check(token, secret)).toEqual({ ok: true, valid: true });
    expect(await check(token, `${secret}k`)).toEqual({ ok: false, error: 'key-too-long' });
  });

  it('refuses a JWK that is not a shared secret for an HMAC token, whatever it is', async () => {
    const token = hmacToken('HS256', 'x'.repeat(16), payload);
    for (const jwk of [
      { kty: 'RSA', k: 'AAAA' },
      { kty: 'EC', k: 'AAAA' },
      { kty: 'oct' },
      { kty: 'oct', k: 5 },
      { kty: 'oct', k: null },
      { k: 'AAAA' },
      {},
    ]) {
      expect(await check(token, JSON.stringify(jwk)), JSON.stringify(jwk)).toEqual({
        ok: false,
        error: 'key-kind',
      });
    }
    expect(await check(token, '{ not json')).toEqual({ ok: false, error: 'key-invalid' });
  });

  it('refuses a key of another kind for a public key token, and a JWK that is not RSA or EC', async () => {
    const pair = rsaKeys();
    const token = rsaToken('RS256', pair, payload);
    for (const jwk of [{ kty: 'oct', k: 'AAAA' }, {}, { kty: 'OKP' }]) {
      expect(await check(token, JSON.stringify(jwk)), JSON.stringify(jwk)).toEqual({
        ok: false,
        error: 'key-kind',
      });
    }
    expect(await check(token, 'plain text')).toEqual({ ok: false, error: 'key-kind' });
  });

  it('says a secret in Base64 that is no Base64 or nothing at all is invalid', async () => {
    const token = hmacToken('HS256', 'x'.repeat(16), payload);
    for (const text of ['A', 'AAAAA', '!!!!', '====', ' = = ']) {
      expect(await check(token, text, true), JSON.stringify(text)).toEqual({
        ok: false,
        error: 'key-invalid',
      });
    }
    expect(await check(token, Buffer.from('x'.repeat(16)).toString('base64'), true)).toEqual({
      ok: true,
      valid: true,
    });
  });

  it('says a PEM block that is not one, or is not Base64, is invalid, and one with another label is not a public key', async () => {
    const token = rsaToken('RS256', rsaKeys(), payload);
    for (const text of [
      '-----BEGIN PUBLIC KEY-----\nAQID',
      '-----BEGIN PUBLIC KEY-----\n!!!!\n-----END PUBLIC KEY-----',
      '-----BEGIN PUBLIC KEY-----\nAQID\n-----END PUBLIC KEY-----',
    ]) {
      expect(await check(token, text), text).toEqual({ ok: false, error: 'key-invalid' });
    }
    expect(
      await check(token, '-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----'),
    ).toEqual({ ok: false, error: 'key-pem' });
    expect(
      await check(token, '-----BEGIN RSA PRIVATE KEY-----\nAQID\n-----END RSA PRIVATE KEY-----'),
    ).toEqual({ ok: false, error: 'key-private' });
  });

  it('says a JWK that WebCrypto cannot import is invalid', async () => {
    const token = rsaToken('RS256', rsaKeys(), payload);
    expect(await check(token, JSON.stringify({ kty: 'RSA' }))).toEqual({
      ok: false,
      error: 'key-invalid',
    });
    expect(
      await check(token, JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' })),
    ).toEqual({ ok: false, error: 'key-invalid' });
  });

  it('says a failure of the check itself is an invalid key, not a result', async () => {
    const pair = ecKeys('P-256');
    const token = ecToken('ES256', pair, payload);
    vi.spyOn(crypto.subtle, 'verify').mockRejectedValue(new Error('no'));
    expect(await check(token, pair.publicPem)).toEqual({ ok: false, error: 'key-invalid' });
    const secret = 'abc';
    expect(await check(hmacToken('HS256', secret, payload), secret)).toEqual({
      ok: false,
      error: 'key-invalid',
    });
  });
});

describe('verifyToken against Node for HMAC with an odd secret', () => {
  it('uses the secret bytes as typed, not trimmed', async () => {
    const secret = '  spaces  ';
    const input = `${b64url(JSON.stringify({ alg: 'HS256' }))}.${b64url(JSON.stringify({ a: 1 }))}`;
    const token = `${input}.${b64url(createHmac('sha256', secret).update(input).digest())}`;
    expect(await check(token, secret)).toEqual({ ok: true, valid: true });
    expect(await check(token, secret.trim())).toEqual({ ok: true, valid: false });
  });
});
