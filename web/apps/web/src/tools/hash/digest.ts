/**
 * Message digests. Text is hashed by WebCrypto (`crypto.subtle.digest`). WebCrypto cannot hash a stream (it
 * needs the whole input in memory), so a file is hashed here, chunk by chunk, by incremental SHA-1,
 * SHA-256, SHA-384 and SHA-512 (FIPS 180-4). The two paths are tested against each other.
 *
 * SHA-1 is offered for checking downloads and old checksums only: collisions can be made on purpose, so it
 * must never be trusted to prove that a file was not tampered with. The page says so.
 */

export const ALGORITHMS = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as const;
export type HashAlgorithm = (typeof ALGORITHMS)[number];

/** The digest of one input under every algorithm, as lowercase hexadecimal. */
export type Digests = Readonly<Record<HashAlgorithm, string>>;

/** Length of the digest in bytes. */
export const DIGEST_BYTES: Readonly<Record<HashAlgorithm, number>> = {
  'SHA-1': 20,
  'SHA-256': 32,
  'SHA-384': 48,
  'SHA-512': 64,
};

/** An incremental hash: feed chunks with `update`, then ask for the digest once. */
export interface Hasher {
  update(data: Uint8Array): void;
  digest(): Uint8Array;
}

const TWO_32 = 4_294_967_296;
const MASK_64 = (1n << 64n) - 1n;

/** The word at `index`; the indices used here are always inside the array (a missing one reads as 0). */
function at(words: ArrayLike<number>, index: number): number {
  return words[index] ?? 0;
}

function rotl(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Buffers the input into blocks and pads it (the Merkle-Damgard layout shared by the SHA-1 and SHA-2 families). */
abstract class BlockHasher implements Hasher {
  readonly #block: Uint8Array;
  readonly #lengthBytes: number;
  #filled = 0;
  #length = 0;
  #finished = false;

  protected constructor(blockSize: number, lengthBytes: number) {
    this.#block = new Uint8Array(blockSize);
    this.#lengthBytes = lengthBytes;
  }

  /** Mixes one full block, starting at `offset` of `data`, into the state. */
  protected abstract compress(data: Uint8Array, offset: number): void;

  /** The state as the big-endian bytes of the digest. */
  protected abstract output(): Uint8Array;

  update(data: Uint8Array): void {
    if (this.#finished) {
      throw new Error('the hash is finished: digest() was already called');
    }
    this.#length += data.length;
    this.#feed(data);
  }

  digest(): Uint8Array {
    if (this.#finished) {
      throw new Error('the hash is finished: digest() was already called');
    }
    this.#finished = true;
    const size = this.#block.length;
    const zeros = (size - ((this.#filled + 1 + this.#lengthBytes) % size)) % size;
    const tail = new Uint8Array(1 + zeros + this.#lengthBytes);
    tail[0] = 0x80;
    const view = new DataView(tail.buffer);
    // The length in bits, as a big-endian number in the last bytes (the high bytes of a
    // 128-bit length stay zero: a JavaScript length never needs them).
    view.setUint32(tail.length - 8, Math.floor(this.#length / 536_870_912));
    view.setUint32(tail.length - 4, (this.#length << 3) >>> 0);
    this.#feed(tail);
    return this.output();
  }

  #feed(data: Uint8Array): void {
    const size = this.#block.length;
    let offset = 0;
    if (this.#filled > 0) {
      const take = Math.min(size - this.#filled, data.length);
      this.#block.set(data.subarray(0, take), this.#filled);
      this.#filled += take;
      offset = take;
      if (this.#filled === size) {
        this.compress(this.#block, 0);
        this.#filled = 0;
      }
    }
    while (offset + size <= data.length) {
      this.compress(data, offset);
      offset += size;
    }
    if (offset < data.length) {
      this.#block.set(data.subarray(offset), 0);
      this.#filled = data.length - offset;
    }
  }
}

function words32(state: Uint32Array, count: number): Uint8Array {
  const bytes = new Uint8Array(count * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < count; index += 1) {
    view.setUint32(index * 4, at(state, index));
  }
  return bytes;
}

class Sha1 extends BlockHasher {
  readonly #state = Uint32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0);
  readonly #w = new Uint32Array(80);

  constructor() {
    super(64, 8);
  }

  protected compress(data: Uint8Array, offset: number): void {
    const w = this.#w;
    const view = new DataView(data.buffer, data.byteOffset + offset, 64);
    for (let t = 0; t < 16; t += 1) {
      w[t] = view.getUint32(t * 4);
    }
    for (let t = 16; t < 80; t += 1) {
      w[t] = rotl(at(w, t - 3) ^ at(w, t - 8) ^ at(w, t - 14) ^ at(w, t - 16), 1);
    }
    const s = this.#state;
    let a = at(s, 0);
    let b = at(s, 1);
    let c = at(s, 2);
    let d = at(s, 3);
    let e = at(s, 4);
    for (let t = 0; t < 80; t += 1) {
      let f: number;
      let k: number;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (rotl(a, 5) + f + e + k + at(w, t)) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = next;
    }
    s[0] = (at(s, 0) + a) >>> 0;
    s[1] = (at(s, 1) + b) >>> 0;
    s[2] = (at(s, 2) + c) >>> 0;
    s[3] = (at(s, 3) + d) >>> 0;
    s[4] = (at(s, 4) + e) >>> 0;
  }

  protected output(): Uint8Array {
    return words32(this.#state, 5);
  }
}

/** The first `count` primes. */
function primes(count: number): number[] {
  const found: number[] = [];
  for (let n = 2; found.length < count; n += 1) {
    if (found.every((p) => n % p !== 0)) {
      found.push(n);
    }
  }
  return found;
}

/** The largest integer whose `degree`-th power is at most `value` (Newton's method on BigInt). */
function integerRoot(value: bigint, degree: bigint): bigint {
  if (value < 2n) {
    return value;
  }
  let x = 1n << BigInt(Math.ceil(value.toString(2).length / Number(degree)));
  for (;;) {
    const next = ((degree - 1n) * x + value / x ** (degree - 1n)) / degree;
    if (next >= x) {
      return x;
    }
    x = next;
  }
}

/**
 * FIPS 180-4 defines the SHA-2 constants as the first 64 bits of the fractional parts of the square and
 * cube roots of the first primes (4.2.2, 5.3.3, 5.3.5). They are derived from that definition, not
 * typed in; the tests compare every digest with WebCrypto, which would fail on a wrong constant.
 */
const PRIMES = primes(80);

function fractionalRoot(prime: number, degree: bigint): bigint {
  const scaled = BigInt(prime) << (64n * degree);
  return integerRoot(scaled, degree) & MASK_64;
}

/** Cube-root constants: 80 of 64 bits (SHA-512); SHA-256 uses the high 32 bits of the first 64. */
const K512: readonly bigint[] = PRIMES.map((prime) => fractionalRoot(prime, 3n));
/** Square-root initial values of the primes 1 to 8 (SHA-256, SHA-512) and 9 to 16 (SHA-384). */
const SQRT: readonly bigint[] = PRIMES.slice(0, 16).map((prime) => fractionalRoot(prime, 2n));

function high(value: bigint): number {
  return Number(value >> 32n);
}

function low(value: bigint): number {
  return Number(value & 0xffff_ffffn);
}

const K256 = Uint32Array.from(K512.slice(0, 64), high);

class Sha256 extends BlockHasher {
  readonly #state = Uint32Array.from(SQRT.slice(0, 8), high);
  readonly #w = new Uint32Array(64);

  constructor() {
    super(64, 8);
  }

  protected compress(data: Uint8Array, offset: number): void {
    const w = this.#w;
    const view = new DataView(data.buffer, data.byteOffset + offset, 64);
    for (let t = 0; t < 16; t += 1) {
      w[t] = view.getUint32(t * 4);
    }
    for (let t = 16; t < 64; t += 1) {
      const w15 = at(w, t - 15);
      const w2 = at(w, t - 2);
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = (at(w, t - 16) + s0 + at(w, t - 7) + s1) >>> 0;
    }
    const s = this.#state;
    let a = at(s, 0);
    let b = at(s, 1);
    let c = at(s, 2);
    let d = at(s, 3);
    let e = at(s, 4);
    let f = at(s, 5);
    let g = at(s, 6);
    let h = at(s, 7);
    for (let t = 0; t < 64; t += 1) {
      const big1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + big1 + choose + at(K256, t) + at(w, t)) >>> 0;
      const big0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (big0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    s[0] = (at(s, 0) + a) >>> 0;
    s[1] = (at(s, 1) + b) >>> 0;
    s[2] = (at(s, 2) + c) >>> 0;
    s[3] = (at(s, 3) + d) >>> 0;
    s[4] = (at(s, 4) + e) >>> 0;
    s[5] = (at(s, 5) + f) >>> 0;
    s[6] = (at(s, 6) + g) >>> 0;
    s[7] = (at(s, 7) + h) >>> 0;
  }

  protected output(): Uint8Array {
    return words32(this.#state, 8);
  }
}

/** The K constants of SHA-512 as (high, low) pairs. */
const K512_WORDS = Uint32Array.from(K512.flatMap((k) => [high(k), low(k)]));

/**
 * SHA-512 and SHA-384 (same compression, other initial values and a shorter output). Every 64-bit word
 * is a (high, low) pair of 32-bit numbers, because a JavaScript number cannot hold 64 bits and BigInt
 * is far too slow for a file.
 */
class Sha512 extends BlockHasher {
  readonly #state: Uint32Array;
  readonly #outputBytes: number;
  readonly #w = new Uint32Array(160);

  constructor(initial: readonly bigint[], outputBytes: number) {
    super(128, 16);
    this.#state = Uint32Array.from(initial.flatMap((word) => [high(word), low(word)]));
    this.#outputBytes = outputBytes;
  }

  protected compress(data: Uint8Array, offset: number): void {
    const w = this.#w;
    const view = new DataView(data.buffer, data.byteOffset + offset, 128);
    for (let t = 0; t < 32; t += 1) {
      w[t] = view.getUint32(t * 4);
    }
    for (let t = 16; t < 80; t += 1) {
      // sigma0 of w[t-15]: ROTR 1 ^ ROTR 8 ^ SHR 7; sigma1 of w[t-2]: ROTR 19 ^ ROTR 61 ^ SHR 6.
      const h15 = at(w, (t - 15) * 2);
      const l15 = at(w, (t - 15) * 2 + 1);
      const s0h = ((h15 >>> 1) | (l15 << 31)) ^ ((h15 >>> 8) | (l15 << 24)) ^ (h15 >>> 7);
      const s0l =
        ((l15 >>> 1) | (h15 << 31)) ^ ((l15 >>> 8) | (h15 << 24)) ^ ((l15 >>> 7) | (h15 << 25));
      const h2 = at(w, (t - 2) * 2);
      const l2 = at(w, (t - 2) * 2 + 1);
      const s1h = ((h2 >>> 19) | (l2 << 13)) ^ ((l2 >>> 29) | (h2 << 3)) ^ (h2 >>> 6);
      const s1l =
        ((l2 >>> 19) | (h2 << 13)) ^ ((h2 >>> 29) | (l2 << 3)) ^ ((l2 >>> 6) | (h2 << 26));
      const lowSum = at(w, (t - 16) * 2 + 1) + (s0l >>> 0) + at(w, (t - 7) * 2 + 1) + (s1l >>> 0);
      const highSum =
        at(w, (t - 16) * 2) +
        (s0h >>> 0) +
        at(w, (t - 7) * 2) +
        (s1h >>> 0) +
        Math.floor(lowSum / TWO_32);
      w[t * 2] = highSum >>> 0;
      w[t * 2 + 1] = lowSum >>> 0;
    }

    const s = this.#state;
    let ah = at(s, 0);
    let al = at(s, 1);
    let bh = at(s, 2);
    let bl = at(s, 3);
    let ch = at(s, 4);
    let cl = at(s, 5);
    let dh = at(s, 6);
    let dl = at(s, 7);
    let eh = at(s, 8);
    let el = at(s, 9);
    let fh = at(s, 10);
    let fl = at(s, 11);
    let gh = at(s, 12);
    let gl = at(s, 13);
    let hh = at(s, 14);
    let hl = at(s, 15);

    for (let t = 0; t < 80; t += 1) {
      // Sigma1(e): ROTR 14 ^ ROTR 18 ^ ROTR 41.
      const big1h =
        ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const big1l =
        ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chooseH = (eh & fh) ^ (~eh & gh);
      const chooseL = (el & fl) ^ (~el & gl);
      const t1l =
        hl + (big1l >>> 0) + (chooseL >>> 0) + at(K512_WORDS, t * 2 + 1) + at(w, t * 2 + 1);
      const t1h =
        hh +
        (big1h >>> 0) +
        (chooseH >>> 0) +
        at(K512_WORDS, t * 2) +
        at(w, t * 2) +
        Math.floor(t1l / TWO_32);
      // Sigma0(a): ROTR 28 ^ ROTR 34 ^ ROTR 39.
      const big0h =
        ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const big0l =
        ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const majH = (ah & bh) ^ (ah & ch) ^ (bh & ch);
      const majL = (al & bl) ^ (al & cl) ^ (bl & cl);
      const t2l = (big0l >>> 0) + (majL >>> 0);
      const t2h = (big0h >>> 0) + (majH >>> 0) + Math.floor(t2l / TWO_32);

      hh = gh;
      hl = gl;
      gh = fh;
      gl = fl;
      fh = eh;
      fl = el;
      const newEl = dl + (t1l % TWO_32);
      eh = (dh + (t1h % TWO_32) + Math.floor(newEl / TWO_32)) >>> 0;
      el = newEl >>> 0;
      dh = ch;
      dl = cl;
      ch = bh;
      cl = bl;
      bh = ah;
      bl = al;
      const newAl = (t1l % TWO_32) + (t2l % TWO_32);
      ah = ((t1h % TWO_32) + (t2h % TWO_32) + Math.floor(newAl / TWO_32)) >>> 0;
      al = newAl >>> 0;
    }

    const next = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl];
    for (let pair = 0; pair < 8; pair += 1) {
      const lowSum = at(s, pair * 2 + 1) + at(next, pair * 2 + 1);
      s[pair * 2 + 1] = lowSum >>> 0;
      s[pair * 2] = (at(s, pair * 2) + at(next, pair * 2) + Math.floor(lowSum / TWO_32)) >>> 0;
    }
  }

  protected output(): Uint8Array {
    return words32(this.#state, 16).subarray(0, this.#outputBytes);
  }
}

/** A new incremental hasher for `algorithm`. */
export function createHasher(algorithm: HashAlgorithm): Hasher {
  switch (algorithm) {
    case 'SHA-1':
      return new Sha1();
    case 'SHA-256':
      return new Sha256();
    case 'SHA-384':
      return new Sha512(SQRT.slice(8, 16), 48);
    case 'SHA-512':
      return new Sha512(SQRT.slice(0, 8), 64);
  }
}

/** Lowercase hexadecimal. */
export function toHex(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, '0');
  }
  return text;
}

/** The bytes of a hexadecimal text of even length (case does not matter); the text is already checked. */
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Standard Base64 with padding. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** The digest of `data` under every algorithm, through WebCrypto. */
export async function digestBytes(data: Uint8Array<ArrayBuffer>): Promise<Digests> {
  const entries = await Promise.all(
    ALGORITHMS.map(
      async (algorithm) =>
        [algorithm, toHex(new Uint8Array(await crypto.subtle.digest(algorithm, data)))] as const,
    ),
  );
  return Object.fromEntries(entries) as Digests;
}

/** The digest of a text, encoded as UTF-8. */
export async function digestText(text: string): Promise<Digests> {
  return digestBytes(new TextEncoder().encode(text));
}

/** What a user-pasted expected digest turned out to be. */
export type Expected =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'hex'; readonly hex: string };

const HEX_LENGTHS = new Set(Object.values(DIGEST_BYTES).map((bytes) => bytes * 2));

/** Reads a pasted checksum: hexadecimal in any case, with spaces, colons or dashes between bytes allowed. */
export function parseExpected(text: string): Expected {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { kind: 'empty' };
  }
  const hex = trimmed.replace(/[\s:-]/g, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || !HEX_LENGTHS.has(hex.length)) {
    return { kind: 'invalid' };
  }
  return { kind: 'hex', hex };
}

/** The algorithms whose digest equals `hex` (usually none or one). */
export function matchingAlgorithms(digests: Digests, hex: string): HashAlgorithm[] {
  return ALGORITHMS.filter((algorithm) => digests[algorithm] === hex);
}
