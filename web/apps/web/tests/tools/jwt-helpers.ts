import {
  constants,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';

/**
 * Tokens and keys for the JWT tests. Every key is made when the tests run and signatures come from
 * `node:crypto`, a second implementation, so the tool is checked against something that is not itself.
 * No key, secret or token is written in the sources.
 */

export function b64url(data: Uint8Array | string): string {
  return Buffer.from(data).toString('base64url');
}

export type Header = Readonly<Record<string, unknown>>;

export interface KeyPair {
  readonly publicPem: string;
  readonly privatePem: string;
  readonly publicJwk: string;
  readonly privateJwk: string;
  readonly privateKey: KeyObject;
}

let rsaPair: KeyPair | undefined;
const curves = new Map<string, KeyPair>();

function wrap(publicKey: KeyObject, privateKey: KeyObject): KeyPair {
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicJwk: JSON.stringify(publicKey.export({ format: 'jwk' })),
    privateJwk: JSON.stringify(privateKey.export({ format: 'jwk' })),
    privateKey,
  };
}

/** One RSA key pair for all RSA tests (generating a 2048-bit key takes a moment). */
export function rsaKeys(): KeyPair {
  if (rsaPair === undefined) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    rsaPair = wrap(publicKey, privateKey);
  }
  return rsaPair;
}

export function ecKeys(curve: 'P-256' | 'P-384' | 'P-521'): KeyPair {
  let pair = curves.get(curve);
  if (pair === undefined) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: curve });
    pair = wrap(publicKey, privateKey);
    curves.set(curve, pair);
  }
  return pair;
}

/** A random shared secret, as text. */
export function randomSecret(): string {
  return randomBytes(32).toString('hex');
}

const HASHES: Readonly<Record<string, string>> = {
  '256': 'sha256',
  '384': 'sha384',
  '512': 'sha512',
};

/** The header and payload parts and what they sign. */
export function signingInput(header: Header, payload: unknown): string {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return `${b64url(JSON.stringify(header))}.${b64url(body)}`;
}

export function hmacToken(
  alg: 'HS256' | 'HS384' | 'HS512',
  secret: string | Uint8Array,
  payload: unknown,
  extraHeader: Header = {},
): string {
  const input = signingInput({ alg, typ: 'JWT', ...extraHeader }, payload);
  const hash = HASHES[alg.slice(2)] ?? 'sha256';
  return `${input}.${b64url(createHmac(hash, secret).update(input).digest())}`;
}

export function rsaToken(
  alg: 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'PS384' | 'PS512',
  pair: KeyPair,
  payload: unknown,
): string {
  const input = signingInput({ alg, typ: 'JWT' }, payload);
  const bits = alg.slice(2);
  const hash = HASHES[bits] ?? 'sha256';
  const signature = alg.startsWith('PS')
    ? sign(hash, Buffer.from(input), {
        key: pair.privateKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: Number(bits) / 8,
      })
    : sign(hash, Buffer.from(input), pair.privateKey);
  return `${input}.${b64url(signature)}`;
}

export function ecToken(alg: 'ES256' | 'ES384' | 'ES512', pair: KeyPair, payload: unknown): string {
  const input = signingInput({ alg, typ: 'JWT' }, payload);
  const hash = HASHES[alg.slice(2)] ?? 'sha256';
  // JWT wants the raw r and s values, not the DER form.
  const signature = sign(hash, Buffer.from(input), {
    key: pair.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${b64url(signature)}`;
}

/** The same token with one bit of its signature flipped. */
export function tamperSignature(token: string): string {
  const [header = '', payload = '', signature = ''] = token.split('.');
  const bytes = Buffer.from(signature, 'base64url');
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return `${header}.${payload}.${b64url(bytes)}`;
}

/** The same token with another payload and the old signature. */
export function swapPayload(token: string, payload: unknown): string {
  const [header = '', , signature = ''] = token.split('.');
  return `${header}.${b64url(JSON.stringify(payload))}.${signature}`;
}
