/**
 * Reading and checking JSON Web Tokens (RFC 7519, RFC 7515) in the browser.
 *
 * Decoding is only reading: anybody can read a token, and what it says is not trustworthy until the
 * signature is checked with the right key. Checking uses WebCrypto and a key the user pastes; the
 * token, the key and the result never leave the page and are never written anywhere (no logging, no
 * storage; a test scans the sources for both).
 */

/** The longest token the tool reads. */
export const MAX_TOKEN_LENGTH = 100_000;
export const MAX_KEY_LENGTH = 20_000;

export type DecodeErrorCode =
  | 'empty'
  | 'too-long'
  | 'encrypted'
  | 'parts'
  | 'base64'
  | 'utf8'
  | 'header-json'
  | 'header-object';

export type JsonObject = Readonly<Record<string, unknown>>;

export interface DecodedToken {
  readonly header: JsonObject;
  /** The header as indented JSON. */
  readonly headerText: string;
  /** The claims, or `undefined` when the payload is not a JSON object. */
  readonly payload: JsonObject | undefined;
  /** The claims as indented JSON, or the payload as it is when it is not JSON. */
  readonly payloadText: string;
  /** The signature as written in the token (Base64url); empty for an unsecured token. */
  readonly signature: string;
  /** What the signature covers: the first two parts, as written. */
  readonly signingInput: string;
  /** The `alg` of the header, when it is a string. */
  readonly algorithm: string | undefined;
}

export type DecodeResult =
  | { readonly ok: true; readonly token: DecodedToken }
  | { readonly ok: false; readonly error: DecodeErrorCode };

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** The bytes of Base64url text (no padding), or `undefined` when it is not Base64url. */
export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64URL.test(text) || text.length % 4 === 1) {
    return undefined;
  }
  const padded = text
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Standard Base64 or Base64url, with or without padding. */
export function decodeBase64Any(text: string): Uint8Array<ArrayBuffer> | undefined {
  return decodeBase64Url(text.replace(/[\s=]/g, '').replaceAll('+', '-').replaceAll('/', '_'));
}

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a user pasted, as a token: without surrounding space, line breaks inside and a leading `Bearer `. */
export function cleanToken(text: string): string {
  const compact = text.replace(/\s/g, '');
  // A header line copied whole ("Authorization: Bearer ...") is cut down to the token: no token starts with these letters.
  let rest = compact;
  if (rest.toLowerCase().startsWith('authorization:')) {
    rest = rest.slice('authorization:'.length);
  }
  return rest.toLowerCase().startsWith('bearer') ? rest.slice('bearer'.length) : rest;
}

/** Reads a compact JWS: header and payload are decoded, nothing is checked. */
export function decodeToken(input: string): DecodeResult {
  if (input.length > MAX_TOKEN_LENGTH) {
    return { ok: false, error: 'too-long' };
  }
  const text = cleanToken(input);
  if (text === '') {
    return { ok: false, error: 'empty' };
  }
  const parts = text.split('.');
  if (parts.length === 5) {
    return { ok: false, error: 'encrypted' };
  }
  if (parts.length !== 3) {
    return { ok: false, error: 'parts' };
  }
  const [headerPart = '', payloadPart = '', signature = ''] = parts;
  const headerBytes = decodeBase64Url(headerPart);
  const payloadBytes = decodeBase64Url(payloadPart);
  if (headerBytes === undefined || payloadBytes === undefined || !BASE64URL.test(signature)) {
    return { ok: false, error: 'base64' };
  }
  const headerSource = utf8(headerBytes);
  const payloadSource = utf8(payloadBytes);
  if (headerSource === undefined || payloadSource === undefined) {
    return { ok: false, error: 'utf8' };
  }
  let header: unknown;
  try {
    header = JSON.parse(headerSource);
  } catch {
    return { ok: false, error: 'header-json' };
  }
  if (!isObject(header)) {
    return { ok: false, error: 'header-object' };
  }
  let payload: JsonObject | undefined;
  let payloadText = payloadSource;
  try {
    const parsed: unknown = JSON.parse(payloadSource);
    if (isObject(parsed)) {
      payload = parsed;
      payloadText = JSON.stringify(parsed, null, 2);
    }
  } catch {
    // A JWS payload may be any bytes: it is shown as it is.
  }
  const algorithm = typeof header['alg'] === 'string' ? header['alg'] : undefined;
  return {
    ok: true,
    token: {
      header,
      headerText: JSON.stringify(header, null, 2),
      payload,
      payloadText,
      signature,
      signingInput: `${headerPart}.${payloadPart}`,
      algorithm,
    },
  };
}

export type TimeClaimName = 'exp' | 'nbf' | 'iat';
export type TimeClaimState = 'expired' | 'not-expired' | 'not-yet-valid' | 'valid-since' | 'issued';

export interface TimeClaim {
  readonly name: TimeClaimName;
  /** Seconds since the epoch. */
  readonly seconds: number;
  /** The moment as ISO 8601 in UTC. */
  readonly iso: string;
  readonly state: TimeClaimState;
}

export interface TimeClaimProblem {
  readonly name: TimeClaimName;
  readonly value: unknown;
}

/** The largest instant a JavaScript date can hold, in milliseconds. */
const MAX_DATE = 8.64e15;

/**
 * The time claims of a payload read against `now` (milliseconds). A claim that is not a number a date can
 * hold is reported as a problem. A token is expired from the moment `exp` is reached, and not valid
 * before `nbf` (RFC 7519, 4.1.4 and 4.1.5).
 */
export function timeClaims(
  payload: JsonObject | undefined,
  now: number,
): { claims: TimeClaim[]; problems: TimeClaimProblem[] } {
  const claims: TimeClaim[] = [];
  const problems: TimeClaimProblem[] = [];
  if (payload === undefined) {
    return { claims, problems };
  }
  for (const name of ['exp', 'nbf', 'iat'] as const) {
    if (!Object.hasOwn(payload, name)) {
      continue;
    }
    const value = payload[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value * 1000) > MAX_DATE) {
      problems.push({ name, value });
      continue;
    }
    const milliseconds = value * 1000;
    let state: TimeClaimState;
    if (name === 'exp') {
      state = now >= milliseconds ? 'expired' : 'not-expired';
    } else if (name === 'nbf') {
      state = now < milliseconds ? 'not-yet-valid' : 'valid-since';
    } else {
      state = 'issued';
    }
    claims.push({ name, seconds: value, iso: new Date(milliseconds).toISOString(), state });
  }
  return { claims, problems };
}

export type VerifyErrorCode =
  | 'no-algorithm'
  | 'unsecured'
  | 'unsupported-algorithm'
  | 'unsupported-header'
  | 'no-signature'
  | 'bad-signature'
  | 'no-key'
  | 'key-too-long'
  | 'key-kind'
  | 'key-private'
  | 'key-pem'
  | 'key-invalid';

export type VerifyResult =
  | { readonly ok: true; readonly valid: boolean }
  | { readonly ok: false; readonly error: VerifyErrorCode; readonly detail?: string };

interface Spec {
  readonly family: 'hmac' | 'rsa-pkcs1' | 'rsa-pss' | 'ecdsa';
  readonly hash: 'SHA-256' | 'SHA-384' | 'SHA-512';
  readonly curve?: 'P-256' | 'P-384' | 'P-521';
}

/** The signature algorithms of RFC 7518 that WebCrypto can check. */
const SPECS: Readonly<Record<string, Spec>> = {
  HS256: { family: 'hmac', hash: 'SHA-256' },
  HS384: { family: 'hmac', hash: 'SHA-384' },
  HS512: { family: 'hmac', hash: 'SHA-512' },
  RS256: { family: 'rsa-pkcs1', hash: 'SHA-256' },
  RS384: { family: 'rsa-pkcs1', hash: 'SHA-384' },
  RS512: { family: 'rsa-pkcs1', hash: 'SHA-512' },
  PS256: { family: 'rsa-pss', hash: 'SHA-256' },
  PS384: { family: 'rsa-pss', hash: 'SHA-384' },
  PS512: { family: 'rsa-pss', hash: 'SHA-512' },
  ES256: { family: 'ecdsa', hash: 'SHA-256', curve: 'P-256' },
  ES384: { family: 'ecdsa', hash: 'SHA-384', curve: 'P-384' },
  ES512: { family: 'ecdsa', hash: 'SHA-512', curve: 'P-521' },
};

/** The algorithms the check supports, for the page to name. */
export const SUPPORTED_ALGORITHMS: readonly string[] = Object.keys(SPECS);

const SALT_BYTES: Readonly<Record<Spec['hash'], number>> = {
  'SHA-256': 32,
  'SHA-384': 48,
  'SHA-512': 64,
};

interface Pem {
  readonly label: string;
  /** The decoded body, or `undefined` when it is not Base64. */
  readonly der: Uint8Array<ArrayBuffer> | undefined;
}

/** Reads one PEM block (`-----BEGIN LABEL-----` ... `-----END LABEL-----`), or `undefined` when it is not one. */
export function readPem(text: string): Pem | undefined {
  const trimmed = text.trim();
  const begin = '-----BEGIN ';
  if (!trimmed.startsWith(begin)) {
    return undefined;
  }
  const labelEnd = trimmed.indexOf('-----', begin.length);
  if (labelEnd < 0) {
    return undefined;
  }
  const label = trimmed.slice(begin.length, labelEnd);
  const footer = `-----END ${label}-----`;
  if (!trimmed.endsWith(footer)) {
    return undefined;
  }
  const body = trimmed.slice(labelEnd + 5, trimmed.length - footer.length).replace(/\s/g, '');
  return { label, der: decodeBase64Any(body) };
}

function isPrivateLabel(label: string): boolean {
  return label.includes('PRIVATE');
}

type KeyImport =
  | { readonly ok: true; readonly key: CryptoKey }
  | { readonly ok: false; readonly error: VerifyErrorCode };

function algorithmOf(spec: Spec): HmacImportParams | RsaHashedImportParams | EcKeyImportParams {
  switch (spec.family) {
    case 'hmac':
      return { name: 'HMAC', hash: spec.hash };
    case 'rsa-pkcs1':
      return { name: 'RSASSA-PKCS1-v1_5', hash: spec.hash };
    case 'rsa-pss':
      return { name: 'RSA-PSS', hash: spec.hash };
    case 'ecdsa':
      return { name: 'ECDSA', namedCurve: spec.curve ?? 'P-256' };
  }
}

async function importKey(spec: Spec, keyText: string, secretIsBase64: boolean): Promise<KeyImport> {
  const algorithm = algorithmOf(spec);
  const text = keyText.trim();
  const isPem = text.startsWith('-----BEGIN ');
  const isJwk = text.startsWith('{');
  try {
    if (spec.family === 'hmac') {
      // An HMAC secret is never a public key: taking a pasted PEM public key as the secret is the
      // classic algorithm-confusion attack, so a key that looks like one is refused.
      if (isPem) {
        return { ok: false, error: 'key-kind' };
      }
      if (isJwk) {
        const jwk = JSON.parse(text) as unknown;
        if (!isObject(jwk) || jwk['kty'] !== 'oct' || typeof jwk['k'] !== 'string') {
          return { ok: false, error: 'key-kind' };
        }
        return {
          ok: true,
          key: await crypto.subtle.importKey('jwk', jwk as JsonWebKey, algorithm, false, [
            'verify',
          ]),
        };
      }
      const bytes = secretIsBase64 ? decodeBase64Any(text) : new TextEncoder().encode(keyText);
      if (bytes === undefined || bytes.length === 0) {
        return { ok: false, error: 'key-invalid' };
      }
      return {
        ok: true,
        key: await crypto.subtle.importKey('raw', bytes, algorithm, false, ['verify']),
      };
    }
    // RSA and EC need a public key: a pasted secret or private key is refused with a reason.
    if (isPem) {
      const pem = readPem(text);
      if (pem?.der === undefined) {
        return { ok: false, error: 'key-invalid' };
      }
      if (isPrivateLabel(pem.label)) {
        return { ok: false, error: 'key-private' };
      }
      if (pem.label !== 'PUBLIC KEY') {
        return { ok: false, error: 'key-pem' };
      }
      return {
        ok: true,
        key: await crypto.subtle.importKey('spki', pem.der, algorithm, false, ['verify']),
      };
    }
    if (isJwk) {
      const jwk = JSON.parse(text) as unknown;
      if (!isObject(jwk) || (jwk['kty'] !== 'RSA' && jwk['kty'] !== 'EC')) {
        return { ok: false, error: 'key-kind' };
      }
      if (Object.hasOwn(jwk, 'd')) {
        return { ok: false, error: 'key-private' };
      }
      return {
        ok: true,
        key: await crypto.subtle.importKey('jwk', jwk as JsonWebKey, algorithm, false, ['verify']),
      };
    }
    return { ok: false, error: 'key-kind' };
  } catch {
    return { ok: false, error: 'key-invalid' };
  }
}

/**
 * Checks the signature of a decoded token with the key the user pasted. The algorithm comes from the token
 * header, and the key must be of the kind that algorithm needs (a secret for HS, a public key for RS, PS
 * and ES), so a token cannot trick the check into using a public key as a secret.
 */
export async function verifyToken(
  token: DecodedToken,
  keyText: string,
  secretIsBase64: boolean,
): Promise<VerifyResult> {
  const { algorithm } = token;
  if (algorithm === undefined) {
    return { ok: false, error: 'no-algorithm' };
  }
  if (algorithm.toLowerCase() === 'none') {
    return { ok: false, error: 'unsecured' };
  }
  const spec = Object.hasOwn(SPECS, algorithm) ? SPECS[algorithm] : undefined;
  if (spec === undefined) {
    return { ok: false, error: 'unsupported-algorithm', detail: algorithm };
  }
  if (token.header['b64'] === false || Object.hasOwn(token.header, 'crit')) {
    return { ok: false, error: 'unsupported-header' };
  }
  if (token.signature === '') {
    return { ok: false, error: 'no-signature' };
  }
  if (keyText.trim() === '') {
    return { ok: false, error: 'no-key' };
  }
  if (keyText.length > MAX_KEY_LENGTH) {
    return { ok: false, error: 'key-too-long' };
  }
  const signature = decodeBase64Url(token.signature);
  if (signature === undefined) {
    return { ok: false, error: 'bad-signature' };
  }
  const imported = await importKey(spec, keyText, secretIsBase64);
  if (!imported.ok) {
    return imported;
  }
  const data = new TextEncoder().encode(token.signingInput);
  try {
    let valid: boolean;
    if (spec.family === 'hmac') {
      valid = await crypto.subtle.verify('HMAC', imported.key, signature, data);
    } else if (spec.family === 'rsa-pkcs1') {
      valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', imported.key, signature, data);
    } else if (spec.family === 'rsa-pss') {
      valid = await crypto.subtle.verify(
        { name: 'RSA-PSS', saltLength: SALT_BYTES[spec.hash] },
        imported.key,
        signature,
        data,
      );
    } else {
      valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: spec.hash },
        imported.key,
        signature,
        data,
      );
    }
    return { ok: true, valid };
  } catch {
    // WebCrypto refuses a key of the wrong kind at this point (for example an RSA key for ES256).
    return { ok: false, error: 'key-invalid' };
  }
}
