import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ALGORITHMS,
  DIGEST_BYTES,
  createHasher,
  digestBytes,
  digestText,
  fromHex,
  lengthField,
  matchingAlgorithms,
  parseExpected,
  toBase64,
  toHex,
  type HashAlgorithm,
} from '../../src/tools/hash/digest.ts';

const NODE_NAMES: Readonly<Record<HashAlgorithm, string>> = {
  'SHA-1': 'sha1',
  'SHA-256': 'sha256',
  'SHA-384': 'sha384',
  'SHA-512': 'sha512',
};

/** A small deterministic generator (xorshift32), so a failing case can be repeated. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

function bytesOf(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const next = random(seed);
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = next() & 0xff;
  }
  return bytes;
}

function reference(algorithm: HashAlgorithm, data: Uint8Array): string {
  return createHash(NODE_NAMES[algorithm]).update(data).digest('hex');
}

function hashed(algorithm: HashAlgorithm, chunks: readonly Uint8Array[]): string {
  const hasher = createHasher(algorithm);
  for (const chunk of chunks) {
    hasher.update(chunk);
  }
  return toHex(hasher.digest());
}

describe.each(ALGORITHMS)('%s (incremental)', (algorithm) => {
  it('hashes the empty input and the standard test strings (FIPS 180-4 examples)', () => {
    const encoder = new TextEncoder();
    for (const text of ['', 'abc', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq']) {
      expect(hashed(algorithm, [encoder.encode(text)])).toBe(
        reference(algorithm, encoder.encode(text)),
      );
    }
  });

  it('is right around every block and padding boundary (0 to 300 bytes)', () => {
    for (let length = 0; length <= 300; length += 1) {
      const data = bytesOf(length, length + 1);
      expect(hashed(algorithm, [data]), `length ${String(length)}`).toBe(
        reference(algorithm, data),
      );
    }
  });

  it('does not depend on how the input is cut into chunks (property, 150 random cuts)', () => {
    const next = random(0x5eed);
    for (let round = 0; round < 150; round += 1) {
      const data = bytesOf(next() % 700, round + 10);
      const chunks: Uint8Array[] = [];
      let offset = 0;
      while (offset < data.length) {
        const size = 1 + (next() % 200);
        chunks.push(data.subarray(offset, offset + size));
        offset += size;
      }
      expect(hashed(algorithm, chunks), `round ${String(round)}`).toBe(reference(algorithm, data));
    }
  });

  it('hashes a megabyte, and the same bytes one at a time, like the reference', () => {
    const data = bytesOf(1_048_576, 99);
    expect(hashed(algorithm, [data])).toBe(reference(algorithm, data));
    const small = bytesOf(1000, 7);
    const single = Array.from(small, (byte) => Uint8Array.of(byte));
    expect(hashed(algorithm, single)).toBe(reference(algorithm, small));
  });

  it('accepts a view into a bigger buffer (offset and length are respected)', () => {
    const backing = bytesOf(500, 3);
    const view = backing.subarray(37, 411);
    expect(hashed(algorithm, [view])).toBe(reference(algorithm, view));
  });

  it('has the length of its digest', () => {
    expect(createHasher(algorithm).digest()).toHaveLength(DIGEST_BYTES[algorithm]);
  });

  it('refuses to be used after the digest was taken', () => {
    const hasher = createHasher(algorithm);
    hasher.digest();
    expect(() => {
      hasher.update(Uint8Array.of(1));
    }).toThrow('the hash is finished');
    expect(() => hasher.digest()).toThrow('the hash is finished');
  });
});

describe('the length field', () => {
  const hex = (bytes: number, fieldBytes: number): string => toHex(lengthField(bytes, fieldBytes));

  it('is the bit length, big-endian, in 8 bytes (SHA-1, SHA-256) or 16 (SHA-384, SHA-512)', () => {
    expect(hex(0, 8)).toBe('0000000000000000');
    expect(hex(3, 8)).toBe('0000000000000018');
    expect(hex(3, 16)).toBe('00000000000000000000000000000018');
  });

  it('carries into the high word once the bit count needs more than 32 bits (512 MiB)', () => {
    // 2^29 bytes are 2^32 bits: the first length whose bit count does not fit into 32 bits.
    expect(hex(2 ** 29 - 1, 8)).toBe('00000000fffffff8');
    expect(hex(2 ** 29, 8)).toBe('0000000100000000');
    expect(hex(2 ** 29 + 1, 8)).toBe('0000000100000008');
    // 33 chunks of 16 MiB, the size the old end-to-end case hashed.
    expect(hex(33 * 2 ** 24, 8)).toBe('0000000108000000');
    expect(hex(2 ** 29, 16)).toBe('00000000000000000000000100000000');
  });

  it('keeps every bit up to the largest safe integer (2^53 - 1 bytes are 2^56 - 8 bits)', () => {
    expect(hex(2 ** 32, 8)).toBe('0000000800000000');
    expect(hex(Number.MAX_SAFE_INTEGER, 8)).toBe('00fffffffffffff8');
    expect(hex(Number.MAX_SAFE_INTEGER, 16)).toBe('000000000000000000fffffffffffff8');
  });

  it('is what the hashers append: a digest over more than one block agrees with node', () => {
    const data = bytesOf(1_000_003, 7);
    for (const algorithm of ALGORITHMS) {
      expect(hashed(algorithm, [data.subarray(0, 4099), data.subarray(4099)])).toBe(
        reference(algorithm, data),
      );
    }
  });
});

describe('WebCrypto and the incremental hashers agree', () => {
  it('on bytes and on text', async () => {
    const data = bytesOf(1234, 5);
    const viaCrypto = await digestBytes(data);
    for (const algorithm of ALGORITHMS) {
      expect(viaCrypto[algorithm]).toBe(hashed(algorithm, [data]));
    }
    const text = 'Grüße, 世界 😀';
    const textDigests = await digestText(text);
    const encoded = new TextEncoder().encode(text);
    for (const algorithm of ALGORITHMS) {
      expect(textDigests[algorithm]).toBe(reference(algorithm, encoded));
    }
  });

  it('hashes the empty text', async () => {
    expect((await digestText(''))['SHA-256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('encodings', () => {
  it('round-trips hexadecimal in both directions', () => {
    const bytes = bytesOf(40, 1);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
    expect(toHex(Uint8Array.of(0, 15, 16, 255))).toBe('000f10ff');
    expect(fromHex('000F10Ff')).toEqual(Uint8Array.of(0, 15, 16, 255));
  });

  it('writes standard Base64 with padding', () => {
    expect(toBase64(new TextEncoder().encode('f'))).toBe('Zg==');
    expect(toBase64(new TextEncoder().encode('fo'))).toBe('Zm8=');
    expect(toBase64(new TextEncoder().encode('foo'))).toBe('Zm9v');
    expect(toBase64(new Uint8Array(0))).toBe('');
  });
});

describe('parseExpected', () => {
  const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  it('treats blank text as nothing to compare', () => {
    expect(parseExpected('')).toEqual({ kind: 'empty' });
    expect(parseExpected('  \n ')).toEqual({ kind: 'empty' });
  });

  it('reads hex in any case, with separators', () => {
    expect(parseExpected(sha256.toUpperCase())).toEqual({ kind: 'hex', hex: sha256 });
    const colons = sha256.replace(/(..)/g, '$1:').slice(0, -1);
    expect(parseExpected(`  ${colons} `)).toEqual({ kind: 'hex', hex: sha256 });
    expect(parseExpected(sha256.replace(/(.{8})/g, '$1 '))).toEqual({ kind: 'hex', hex: sha256 });
    expect(parseExpected(sha256.replace(/(.{8})/g, '$1-'))).toEqual({ kind: 'hex', hex: sha256 });
  });

  it('accepts exactly the four digest lengths', () => {
    for (const length of [40, 64, 96, 128]) {
      expect(parseExpected('a'.repeat(length)).kind).toBe('hex');
      expect(parseExpected('a'.repeat(length - 1)).kind).toBe('invalid');
      expect(parseExpected('a'.repeat(length + 1)).kind).toBe('invalid');
    }
  });

  it('rejects text that is not hexadecimal', () => {
    expect(parseExpected(`${'a'.repeat(63)}g`)).toEqual({ kind: 'invalid' });
    expect(parseExpected('hello')).toEqual({ kind: 'invalid' });
  });
});

describe('matchingAlgorithms', () => {
  it('names the algorithms whose digest equals the given one', async () => {
    const digests = await digestText('abc');
    expect(matchingAlgorithms(digests, digests['SHA-384'])).toEqual(['SHA-384']);
    expect(matchingAlgorithms(digests, 'ab'.repeat(32))).toEqual([]);
    const twin = { ...digests, 'SHA-1': digests['SHA-256'] };
    expect(matchingAlgorithms(twin, digests['SHA-256'])).toEqual(['SHA-1', 'SHA-256']);
  });
});
