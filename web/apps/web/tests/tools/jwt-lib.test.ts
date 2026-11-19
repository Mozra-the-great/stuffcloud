import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_KEY_LENGTH,
  MAX_TOKEN_LENGTH,
  SUPPORTED_ALGORITHMS,
  cleanToken,
  decodeBase64Any,
  decodeBase64Url,
  decodeToken,
  readPem,
  timeClaims,
  verifyToken,
  type DecodedToken,
  type DecodeErrorCode,
  type VerifyErrorCode,
} from '../../src/tools/jwt/jwt.ts';
import { appRoot } from '../helpers.ts';
import {
  b64url,
  ecKeys,
  ecToken,
  hmacToken,
  randomSecret,
  rsaKeys,
  rsaToken,
  signingInput,
  swapPayload,
  tamperSignature,
} from './jwt-helpers.ts';

function decode(token: string): DecodedToken {
  const result = decodeToken(token);
  if (!result.ok) {
    throw new Error(`expected a token, got ${result.error}`);
  }
  return result.token;
}

function decodeError(token: string): DecodeErrorCode | undefined {
  const result = decodeToken(token);
  return result.ok ? undefined : result.error;
}

describe('decodeBase64Url', () => {
  it('reads text without padding', () => {
    expect(decodeBase64Url('')).toEqual(new Uint8Array(0));
    expect(decodeBase64Url('Zg')).toEqual(Uint8Array.of(0x66));
    expect(decodeBase64Url('Zm8')).toEqual(Uint8Array.of(0x66, 0x6f));
    expect(decodeBase64Url('Zm9v')).toEqual(Uint8Array.of(0x66, 0x6f, 0x6f));
    expect(decodeBase64Url('-_8')).toEqual(Uint8Array.of(0xfb, 0xff));
  });

  it('refuses padding, the standard alphabet, spaces and an impossible length', () => {
    expect(decodeBase64Url('Zg==')).toBeUndefined();
    expect(decodeBase64Url('+/8')).toBeUndefined();
    expect(decodeBase64Url('Zm 9')).toBeUndefined();
    expect(decodeBase64Url('Z')).toBeUndefined();
    expect(decodeBase64Url('Zm9vY')).toBeUndefined();
  });
});

describe('decodeBase64Any', () => {
  it('reads Base64 and Base64url, with or without padding', () => {
    for (const text of ['Zm9vYg==', 'Zm9vYg', 'Zm9v\nYg==']) {
      expect(decodeBase64Any(text)).toEqual(Uint8Array.of(0x66, 0x6f, 0x6f, 0x62));
    }
    expect(decodeBase64Any('+/8=')).toEqual(Uint8Array.of(0xfb, 0xff));
    expect(decodeBase64Any('-_8')).toEqual(Uint8Array.of(0xfb, 0xff));
    expect(decodeBase64Any('not base64!')).toBeUndefined();
  });
});

describe('cleanToken', () => {
  it('removes whitespace, even inside the token', () => {
    expect(cleanToken('  a.b\n.c \t')).toBe('a.b.c');
  });

  it('cuts a pasted header line or Bearer word down to the token', () => {
    expect(cleanToken('Bearer a.b.c')).toBe('a.b.c');
    expect(cleanToken('bearer a.b.c')).toBe('a.b.c');
    expect(cleanToken('Authorization: Bearer a.b.c')).toBe('a.b.c');
    expect(cleanToken('authorization:a.b.c')).toBe('a.b.c');
  });
});

describe('decodeToken', () => {
  const payload = { sub: 'user-1', name: 'Müller', admin: true, n: 1.5, nested: { a: [1, 2] } };

  it('reads header and payload and shows them as indented JSON', () => {
    const token = hmacToken('HS256', randomSecret(), payload);
    const decoded = decode(token);
    expect(decoded.header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(decoded.headerText).toBe('{\n  "alg": "HS256",\n  "typ": "JWT"\n}');
    expect(decoded.payload).toEqual(payload);
    expect(decoded.payloadText).toBe(JSON.stringify(payload, null, 2));
    expect(decoded.algorithm).toBe('HS256');
    expect(decoded.signingInput).toBe(token.split('.').slice(0, 2).join('.'));
    expect(decoded.signature).toBe(token.split('.')[2]);
  });

  it('reads non-ASCII text as UTF-8', () => {
    const token = hmacToken('HS256', randomSecret(), { name: 'ä€😀' });
    expect(decode(token).payload).toEqual({ name: 'ä€😀' });
  });

  it('accepts a token with line breaks, spaces and a Bearer word', () => {
    const token = hmacToken('HS256', randomSecret(), payload);
    const wrapped = `Authorization: Bearer ${token.slice(0, 20)}\n  ${token.slice(20)}\n`;
    expect(decode(wrapped).payload).toEqual(payload);
  });

  it('shows a payload that is not a JSON object as it is', () => {
    const header = { alg: 'HS256' };
    for (const body of ['plain text', '[1,2]', '42', 'null', '"str"']) {
      const decoded = decode(`${signingInput(header, body)}.${b64url('x')}`);
      expect(decoded.payload).toBeUndefined();
      expect(decoded.payloadText).toBe(body);
    }
  });

  it('reads an unsecured token with an empty signature', () => {
    const decoded = decode(`${signingInput({ alg: 'none' }, { a: 1 })}.`);
    expect(decoded.signature).toBe('');
    expect(decoded.algorithm).toBe('none');
  });

  it('has no algorithm when the header gives none, or not a string', () => {
    expect(decode(`${signingInput({ typ: 'JWT' }, {})}.`).algorithm).toBeUndefined();
    expect(decode(`${signingInput({ alg: 5 }, {})}.`).algorithm).toBeUndefined();
  });

  it('says what is wrong, for every kind of mistake', () => {
    const good = hmacToken('HS256', randomSecret(), payload);
    const [header = '', body = ''] = good.split('.');
    expect(decodeError('')).toBe('empty');
    expect(decodeError('  \n ')).toBe('empty');
    expect(decodeError('a'.repeat(MAX_TOKEN_LENGTH + 1))).toBe('too-long');
    expect(decodeError('a.b.c.d.e')).toBe('encrypted');
    expect(decodeError('a')).toBe('parts');
    expect(decodeError('a.b')).toBe('parts');
    expect(decodeError('a.b.c.d')).toBe('parts');
    expect(decodeError('a.b.c.d.e.f')).toBe('parts');
    expect(decodeError(`${header}.${body}.sig!`)).toBe('base64');
    expect(decodeError(`${header}$.${body}.sig`)).toBe('base64');
    expect(decodeError(`${header}.${body}=.sig`)).toBe('base64');
    expect(decodeError(`${header}.Z.sig`)).toBe('base64');
    expect(decodeError(`${b64url(Uint8Array.of(0xff, 0xfe))}.${body}.sig`)).toBe('utf8');
    expect(decodeError(`${header}.${b64url(Uint8Array.of(0xc3))}.sig`)).toBe('utf8');
    expect(decodeError(`${b64url('{not json')}.${body}.sig`)).toBe('header-json');
    expect(decodeError(`${b64url('[1]')}.${body}.sig`)).toBe('header-object');
    expect(decodeError(`${b64url('"text"')}.${body}.sig`)).toBe('header-object');
    expect(decodeError(`${b64url('null')}.${body}.sig`)).toBe('header-object');
  });

  it('accepts a token at the size limit', () => {
    const filler = 'a'.repeat(Math.floor(((MAX_TOKEN_LENGTH - 200) * 3) / 4));
    expect(decodeError(`${signingInput({ alg: 'none' }, { filler })}.`)).not.toBe('too-long');
  });
});

describe('timeClaims', () => {
  const now = Date.UTC(2026, 5, 1, 10, 0, 0);
  const seconds = now / 1000;

  it('is empty without a payload or without time claims', () => {
    expect(timeClaims(undefined, now)).toEqual({ claims: [], problems: [] });
    expect(timeClaims({ sub: 'x' }, now)).toEqual({ claims: [], problems: [] });
  });

  it('expires a token from the moment exp is reached', () => {
    expect(timeClaims({ exp: seconds + 1 }, now).claims[0]?.state).toBe('not-expired');
    expect(timeClaims({ exp: seconds }, now).claims[0]?.state).toBe('expired');
    expect(timeClaims({ exp: seconds - 1 }, now).claims[0]?.state).toBe('expired');
    expect(timeClaims({ exp: seconds }, now - 1).claims[0]?.state).toBe('not-expired');
  });

  it('is valid from nbf on, and not before', () => {
    expect(timeClaims({ nbf: seconds + 1 }, now).claims[0]?.state).toBe('not-yet-valid');
    expect(timeClaims({ nbf: seconds }, now).claims[0]?.state).toBe('valid-since');
    expect(timeClaims({ nbf: seconds - 5 }, now).claims[0]?.state).toBe('valid-since');
  });

  it('reports iat as issued, in any case', () => {
    expect(timeClaims({ iat: seconds + 3600 }, now).claims[0]?.state).toBe('issued');
    expect(timeClaims({ iat: seconds - 3600 }, now).claims[0]?.state).toBe('issued');
  });

  it('lists the claims in the order exp, nbf, iat with their ISO times', () => {
    const { claims } = timeClaims({ iat: 0, nbf: 86_400, exp: 1_780_308_000.5 }, now);
    expect(claims.map((c) => c.name)).toEqual(['exp', 'nbf', 'iat']);
    expect(claims[0]).toMatchObject({ seconds: 1_780_308_000.5, iso: '2026-06-01T10:00:00.500Z' });
    expect(claims[1]?.iso).toBe('1970-01-02T00:00:00.000Z');
    expect(claims[2]?.iso).toBe('1970-01-01T00:00:00.000Z');
  });

  it('reports a claim that is not a time a date can hold', () => {
    const { claims, problems } = timeClaims({ exp: '1780308000', nbf: null, iat: 1e30 }, now);
    expect(claims).toEqual([]);
    expect(problems.map((p) => p.name)).toEqual(['exp', 'nbf', 'iat']);
    expect(problems[0]).toEqual({ name: 'exp', value: '1780308000' });
    expect(timeClaims({ exp: Number.NaN }, now).problems).toHaveLength(1);
    expect(timeClaims({ exp: 8.64e12 }, now).problems).toHaveLength(0);
    expect(timeClaims({ exp: 8.64e12 + 1 }, now).problems).toHaveLength(1);
  });

  it('does not read inherited properties', () => {
    expect(timeClaims(Object.create({ exp: 5 }) as Record<string, unknown>, now).claims).toEqual(
      [],
    );
  });
});

describe('readPem', () => {
  it('reads the label and the body', () => {
    const pem = readPem('-----BEGIN PUBLIC KEY-----\nAQID\n-----END PUBLIC KEY-----\n');
    expect(pem).toEqual({ label: 'PUBLIC KEY', der: Uint8Array.of(1, 2, 3) });
  });

  it('keeps a label with spaces and tolerates line breaks and spaces in the body', () => {
    const pem = readPem('-----BEGIN RSA PUBLIC KEY-----\r\nAQ ID\r\n-----END RSA PUBLIC KEY-----');
    expect(pem).toEqual({ label: 'RSA PUBLIC KEY', der: Uint8Array.of(1, 2, 3) });
  });

  it('says the body is not Base64 by leaving it out', () => {
    expect(readPem('-----BEGIN PUBLIC KEY-----\n!!!\n-----END PUBLIC KEY-----')).toEqual({
      label: 'PUBLIC KEY',
      der: undefined,
    });
  });

  it('is undefined for text that is not one block', () => {
    expect(readPem('hello')).toBeUndefined();
    expect(readPem('-----BEGIN PUBLIC KEY')).toBeUndefined();
    expect(readPem('-----BEGIN PUBLIC KEY-----\nAQID')).toBeUndefined();
    expect(readPem('-----BEGIN PUBLIC KEY-----\nAQID\n-----END PRIVATE KEY-----')).toBeUndefined();
  });
});

async function check(
  token: string,
  key: string,
  secretIsBase64 = false,
): Promise<{ ok: true; valid: boolean } | { ok: false; error: VerifyErrorCode; detail?: string }> {
  return verifyToken(decode(token), key, secretIsBase64);
}

describe('verifyToken: shared secrets (HS256, HS384, HS512)', () => {
  const payload = { sub: 'user-1' };

  it.each(['HS256', 'HS384', 'HS512'] as const)('accepts the right secret for %s', async (alg) => {
    const secret = randomSecret();
    expect(await check(hmacToken(alg, secret, payload), secret)).toEqual({ ok: true, valid: true });
  });

  it.each(['HS256', 'HS384', 'HS512'] as const)(
    'rejects a wrong secret, a changed payload and a changed signature for %s',
    async (alg) => {
      const secret = randomSecret();
      const token = hmacToken(alg, secret, payload);
      expect(await check(token, randomSecret())).toEqual({ ok: true, valid: false });
      expect(await check(swapPayload(token, { sub: 'admin' }), secret)).toEqual({
        ok: true,
        valid: false,
      });
      expect(await check(tamperSignature(token), secret)).toEqual({ ok: true, valid: false });
      expect(await check(token, `${secret} `)).toEqual({ ok: true, valid: false });
      expect(await check(token, ` ${secret.slice(1)}`)).toEqual({ ok: true, valid: false });
    },
  );

  it('takes a secret written as text exactly as it is, spaces included', async () => {
    const secret = ` ${randomSecret()}`;
    const token = hmacToken('HS256', secret, payload);
    expect(await check(token, secret)).toEqual({ ok: true, valid: true });
  });

  it('takes a secret that is Base64 or Base64url encoded when asked to', async () => {
    const bytes = new Uint8Array(32).map((_, index) => (index * 37 + 11) % 256);
    const token = hmacToken('HS256', bytes, payload);
    expect(await check(token, Buffer.from(bytes).toString('base64'), true)).toEqual({
      ok: true,
      valid: true,
    });
    expect(await check(token, Buffer.from(bytes).toString('base64url'), true)).toEqual({
      ok: true,
      valid: true,
    });
    expect(await check(token, Buffer.from(bytes).toString('base64'), false)).toEqual({
      ok: true,
      valid: false,
    });
    expect(await check(token, '***', true)).toEqual({ ok: false, error: 'key-invalid' });
  });

  it('takes a JWK of type oct', async () => {
    const secret = randomSecret();
    const token = hmacToken('HS256', secret, payload);
    const jwk = JSON.stringify({ kty: 'oct', k: b64url(secret) });
    expect(await check(token, jwk)).toEqual({ ok: true, valid: true });
    expect(await check(token, JSON.stringify({ kty: 'oct', k: b64url(randomSecret()) }))).toEqual({
      ok: true,
      valid: false,
    });
    expect(await check(token, JSON.stringify({ kty: 'RSA', n: 'x', e: 'AQAB' }))).toEqual({
      ok: false,
      error: 'key-kind',
    });
    expect(await check(token, JSON.stringify({ kty: 'oct' }))).toEqual({
      ok: false,
      error: 'key-kind',
    });
    expect(await check(token, '{"kty":')).toEqual({ ok: false, error: 'key-invalid' });
    // Text that does not start with a brace is a secret, whatever else it looks like.
    expect(await check(token, '[1]')).toEqual({ ok: true, valid: false });
  });

  it('refuses a public key as the secret (algorithm confusion)', async () => {
    const pair = rsaKeys();
    // The attacker signs an HS256 token with the text of the public key: the check must not go along.
    const forged = hmacToken('HS256', pair.publicPem, payload);
    expect(await check(forged, pair.publicPem)).toEqual({ ok: false, error: 'key-kind' });
    expect(await check(forged, pair.publicJwk)).toEqual({ ok: false, error: 'key-kind' });
    const ec = ecKeys('P-256');
    expect(await check(hmacToken('HS256', ec.publicPem, payload), ec.publicPem)).toEqual({
      ok: false,
      error: 'key-kind',
    });
  });

  it('refuses an empty secret that is Base64 of nothing', async () => {
    expect(await check(hmacToken('HS256', randomSecret(), payload), '=', true)).toEqual({
      ok: false,
      error: 'key-invalid',
    });
  });
});

describe('verifyToken: public keys (RS, PS, ES)', () => {
  const payload = { sub: 'user-2', scope: 'read' };

  it.each(['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512'] as const)(
    'accepts the right public key for %s as PEM and as JWK, and rejects damage',
    async (alg) => {
      const pair = rsaKeys();
      const token = rsaToken(alg, pair, payload);
      expect(await check(token, pair.publicPem)).toEqual({ ok: true, valid: true });
      expect(await check(token, pair.publicJwk)).toEqual({ ok: true, valid: true });
      expect(await check(tamperSignature(token), pair.publicPem)).toEqual({
        ok: true,
        valid: false,
      });
      expect(await check(swapPayload(token, { sub: 'admin' }), pair.publicPem)).toEqual({
        ok: true,
        valid: false,
      });
    },
    30_000,
  );

  it('does not accept the signature of another key pair', async () => {
    const token = rsaToken('RS256', rsaKeys(), payload);
    expect(await check(token, ecKeys('P-256').publicPem)).toEqual({
      ok: false,
      error: 'key-invalid',
    });
  });

  it.each([
    ['ES256', 'P-256'],
    ['ES384', 'P-384'],
    ['ES512', 'P-521'],
  ] as const)('accepts the right public key for %s and rejects damage', async (alg, curve) => {
    const pair = ecKeys(curve);
    const token = ecToken(alg, pair, payload);
    expect(await check(token, pair.publicPem)).toEqual({ ok: true, valid: true });
    expect(await check(token, pair.publicJwk)).toEqual({ ok: true, valid: true });
    expect(await check(tamperSignature(token), pair.publicPem)).toEqual({ ok: true, valid: false });
    expect(await check(swapPayload(token, { sub: 'admin' }), pair.publicJwk)).toEqual({
      ok: true,
      valid: false,
    });
  });

  it('says a signature of the wrong length is not valid', async () => {
    const pair = ecKeys('P-256');
    const token = ecToken('ES256', pair, payload);
    const short = `${token.split('.').slice(0, 2).join('.')}.${b64url(Uint8Array.of(1, 2, 3))}`;
    expect(await check(short, pair.publicPem)).toEqual({ ok: true, valid: false });
  });

  it('says a key on another curve does not fit', async () => {
    const token = ecToken('ES384', ecKeys('P-384'), payload);
    expect(await check(token, ecKeys('P-256').publicPem)).toEqual({
      ok: false,
      error: 'key-invalid',
    });
    expect(await check(token, ecKeys('P-256').publicJwk)).toEqual({
      ok: false,
      error: 'key-invalid',
    });
    expect(await check(token, rsaKeys().publicPem)).toEqual({ ok: false, error: 'key-invalid' });
  });

  it('refuses a private key, as PEM and as JWK', async () => {
    const pair = ecKeys('P-256');
    const token = ecToken('ES256', pair, payload);
    expect(await check(token, pair.privatePem)).toEqual({ ok: false, error: 'key-private' });
    expect(await check(token, pair.privateJwk)).toEqual({ ok: false, error: 'key-private' });
  });

  it('refuses a secret, a certificate and a PKCS#1 block where a public key is needed', async () => {
    const pair = ecKeys('P-256');
    const token = ecToken('ES256', pair, payload);
    expect(await check(token, randomSecret())).toEqual({ ok: false, error: 'key-kind' });
    expect(await check(token, JSON.stringify({ kty: 'oct', k: 'AQID' }))).toEqual({
      ok: false,
      error: 'key-kind',
    });
    const body = pair.publicPem.split('\n').slice(1, -2).join('\n');
    expect(
      await check(token, `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`),
    ).toEqual({ ok: false, error: 'key-pem' });
    expect(
      await check(token, `-----BEGIN RSA PUBLIC KEY-----\n${body}\n-----END RSA PUBLIC KEY-----`),
    ).toEqual({ ok: false, error: 'key-pem' });
  });

  it('says a damaged key block is invalid', async () => {
    const pair = ecKeys('P-256');
    const token = ecToken('ES256', pair, payload);
    expect(await check(token, '-----BEGIN PUBLIC KEY-----\n!!!\n-----END PUBLIC KEY-----')).toEqual(
      {
        ok: false,
        error: 'key-invalid',
      },
    );
    expect(
      await check(token, '-----BEGIN PUBLIC KEY-----\nAQID\n-----END PUBLIC KEY-----'),
    ).toEqual({
      ok: false,
      error: 'key-invalid',
    });
    expect(await check(token, '-----BEGIN PUBLIC KEY-----\nAQID')).toEqual({
      ok: false,
      error: 'key-invalid',
    });
  });
});

describe('verifyToken: what cannot be checked', () => {
  const secret = randomSecret();
  const payload = { sub: 'x' };

  it('says an unsecured token has nothing to check, in any spelling of none', async () => {
    for (const alg of ['none', 'None', 'NONE']) {
      const token = `${signingInput({ alg }, payload)}.`;
      expect(await check(token, secret)).toEqual({ ok: false, error: 'unsecured' });
    }
    // Even with a signature, "none" is never checked as if it were valid.
    expect(await check(`${signingInput({ alg: 'none' }, payload)}.abcd`, secret)).toEqual({
      ok: false,
      error: 'unsecured',
    });
  });

  it('needs an algorithm in the header', async () => {
    expect(await check(`${signingInput({ typ: 'JWT' }, payload)}.abcd`, secret)).toEqual({
      ok: false,
      error: 'no-algorithm',
    });
    expect(await check(`${signingInput({ alg: 256 }, payload)}.abcd`, secret)).toEqual({
      ok: false,
      error: 'no-algorithm',
    });
  });

  it('names an algorithm it does not support, including ones that are only names of objects', async () => {
    for (const alg of [
      'EdDSA',
      'HS1024',
      'RS999',
      'hs256',
      'constructor',
      '__proto__',
      'toString',
    ]) {
      expect(await check(`${signingInput({ alg }, payload)}.abcd`, secret)).toEqual({
        ok: false,
        error: 'unsupported-algorithm',
        detail: alg,
      });
    }
  });

  it('lists the supported algorithms', () => {
    expect(SUPPORTED_ALGORITHMS).toEqual([
      'HS256',
      'HS384',
      'HS512',
      'RS256',
      'RS384',
      'RS512',
      'PS256',
      'PS384',
      'PS512',
      'ES256',
      'ES384',
      'ES512',
    ]);
  });

  it('does not check a token whose header changes how it is signed', async () => {
    expect(await check(hmacToken('HS256', secret, payload, { crit: ['exp'] }), secret)).toEqual({
      ok: false,
      error: 'unsupported-header',
    });
    expect(await check(hmacToken('HS256', secret, payload, { b64: false }), secret)).toEqual({
      ok: false,
      error: 'unsupported-header',
    });
    expect(await check(hmacToken('HS256', secret, payload, { b64: true }), secret)).toEqual({
      ok: true,
      valid: true,
    });
  });

  it('needs a signature, a readable signature and a key', async () => {
    const header = { alg: 'HS256' };
    expect(await check(`${signingInput(header, payload)}.`, secret)).toEqual({
      ok: false,
      error: 'no-signature',
    });
    expect(await check(`${signingInput(header, payload)}.abcde`, secret)).toEqual({
      ok: false,
      error: 'bad-signature',
    });
    const token = hmacToken('HS256', secret, payload);
    expect(await check(token, '')).toEqual({ ok: false, error: 'no-key' });
    expect(await check(token, ' \n ')).toEqual({ ok: false, error: 'no-key' });
    expect(await check(token, 'a'.repeat(MAX_KEY_LENGTH + 1))).toEqual({
      ok: false,
      error: 'key-too-long',
    });
  });
});

describe('the sources of the JWT tool', () => {
  const directory = join(appRoot, 'src', 'tools', 'jwt');
  const sources = readdirSync(directory).map((file) => [
    file,
    readFileSync(join(directory, file), 'utf8'),
  ]);

  it('never log, store or send a token or a key', () => {
    expect(sources.length).toBeGreaterThanOrEqual(3);
    for (const [file, source] of sources) {
      for (const forbidden of [
        /\bconsole\b/,
        /\blocalStorage\b/,
        /\bsessionStorage\b/,
        /\bindexedDB\b/,
        /document\s*\.\s*cookie/,
        /\bpostMessage\b/,
        /\bBroadcastChannel\b/,
        /\bnavigator\s*\.\s*(?:sendBeacon|serviceWorker)\b/,
        /\blocation\b/,
        /\bhistory\b/,
        /\bdebugger\b/,
      ]) {
        expect(source, `${String(file)}: ${String(forbidden)}`).not.toMatch(forbidden);
      }
    }
  });
});
