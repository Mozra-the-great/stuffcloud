import { randomFillSync, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_COUNT,
  MIN_COUNT,
  Uuid7Generator,
  advance,
  fillSecure,
  formatForDisplay,
  formatUuid,
  formatV7,
  generateBatch,
  uuidV4,
  v7Milliseconds,
  type FillBytes,
} from '../../src/tools/uuid/uuid.ts';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const nodeFill: FillBytes = (bytes) => {
  randomFillSync(bytes);
};

/** Fills with a fixed byte, so the result can be written out. */
function constant(byte: number): FillBytes {
  return (bytes) => {
    bytes.fill(byte);
  };
}

describe('formatUuid', () => {
  it('writes 16 bytes in the 8-4-4-4-12 form', () => {
    expect(formatUuid(Uint8Array.from({ length: 16 }, (_, index) => index))).toBe(
      '00010203-0405-0607-0809-0a0b0c0d0e0f',
    );
    expect(formatUuid(new Uint8Array(16).fill(255))).toBe('ffffffff-ffff-ffff-ffff-ffffffffffff');
  });

  it('refuses any other length', () => {
    expect(() => formatUuid(new Uint8Array(15))).toThrow('a UUID has 16 bytes, got 15');
    expect(() => formatUuid(new Uint8Array(17))).toThrow('a UUID has 16 bytes, got 17');
  });
});

describe('version 4', () => {
  it('sets the version and the variant whatever the random bytes are', () => {
    expect(uuidV4(constant(0x00))).toBe('00000000-0000-4000-8000-000000000000');
    expect(uuidV4(constant(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(uuidV4(constant(0xa5))).toBe('a5a5a5a5-a5a5-45a5-a5a5-a5a5a5a5a5a5');
  });

  it('matches the format of node:crypto randomUUID and is different every time', () => {
    expect(randomUUID()).toMatch(V4);
    const seen = new Set<string>();
    for (let index = 0; index < 2000; index += 1) {
      const uuid = uuidV4();
      expect(uuid).toMatch(V4);
      seen.add(uuid);
    }
    expect(seen.size).toBe(2000);
  });

  it('uses crypto.getRandomValues by default and nothing else', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    const random = vi.spyOn(Math, 'random');
    try {
      uuidV4();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(random).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      random.mockRestore();
    }
    const bytes = new Uint8Array(16);
    fillSecure(bytes);
    expect(bytes.some((byte) => byte !== 0)).toBe(true);
  });

  it('has about half of every bit set over many UUIDs (a sanity check of the bit layout)', () => {
    const counts = new Array<number>(128).fill(0);
    const rounds = 4000;
    for (let round = 0; round < rounds; round += 1) {
      const hex = uuidV4().replaceAll('-', '');
      for (let bit = 0; bit < 128; bit += 1) {
        const nibble = Number.parseInt(hex.charAt(Math.floor(bit / 4)), 16);
        if (((nibble >> (3 - (bit % 4))) & 1) === 1) {
          counts[bit] = (counts[bit] ?? 0) + 1;
        }
      }
    }
    // Bits 48..51 (version) and 64..65 (variant) are fixed; every other bit is a fair coin.
    const fixed = new Set([48, 49, 50, 51, 64, 65]);
    for (const [bit, count] of counts.entries()) {
      if (!fixed.has(bit)) {
        expect(count / rounds).toBeGreaterThan(0.45);
        expect(count / rounds).toBeLessThan(0.55);
      }
    }
  });
});

describe('formatV7', () => {
  it('puts the timestamp in the first 48 bits and the random bits after the version', () => {
    expect(formatV7(0, 0n)).toBe('00000000-0000-7000-8000-000000000000');
    expect(formatV7(0x0123_4567_89ab, 0n)).toBe('01234567-89ab-7000-8000-000000000000');
    expect(formatV7(2 ** 48 - 1, (1n << 74n) - 1n)).toBe('ffffffff-ffff-7fff-bfff-ffffffffffff');
    // rand_a is the top 12 bits of the 74, rand_b the low 62.
    expect(formatV7(0, 0xabcn << 62n)).toBe('00000000-0000-7abc-8000-000000000000');
    expect(formatV7(0, 1n)).toBe('00000000-0000-7000-8000-000000000001');
    expect(formatV7(0, 0x3fffn << 48n)).toBe('00000000-0000-7000-bfff-000000000000');
  });

  it('writes a timestamp larger than 2^32 correctly', () => {
    expect(formatV7(1_800_000_000_000, 0n).slice(0, 13)).toBe(
      `${(1_800_000_000_000).toString(16).padStart(12, '0').slice(0, 8)}-${(1_800_000_000_000).toString(16).padStart(12, '0').slice(8)}`,
    );
  });
});

describe('advance', () => {
  it('adds the step and reports an overflow of the 74 bits', () => {
    expect(advance(5n, 7n)).toBe(12n);
    expect(advance((1n << 74n) - 2n, 1n)).toBe((1n << 74n) - 1n);
    expect(advance((1n << 74n) - 1n, 1n)).toBeUndefined();
    expect(advance(1n << 73n, 1n << 73n)).toBeUndefined();
  });
});

describe('version 7 generator', () => {
  it('has the format, the version and the variant, and the timestamp of the clock', () => {
    const generator = new Uuid7Generator(() => 1_760_000_000_123, nodeFill);
    const uuid = generator.next();
    expect(uuid).toMatch(V7);
    expect(v7Milliseconds(uuid)).toBe(1_760_000_000_123);
  });

  it('is strictly increasing across milliseconds, inside one millisecond and over a clock that steps back', () => {
    const clock = [100, 100, 100, 101, 101, 50, 50, 102, 102, 102, 102];
    let index = 0;
    const generator = new Uuid7Generator(() => clock[index++] ?? 200, nodeFill);
    const made = clock.map(() => generator.next());
    for (let position = 1; position < made.length; position += 1) {
      expect((made[position] ?? '') > (made[position - 1] ?? '')).toBe(true);
    }
    // A step back keeps the last timestamp instead of going back.
    expect(v7Milliseconds(made[5] ?? '')).toBe(101);
    expect(v7Milliseconds(made[6] ?? '')).toBe(101);
    expect(v7Milliseconds(made[7] ?? '')).toBe(102);
  });

  it('stays in order when the random bytes are the worst case (all zero or all ones)', () => {
    for (const byte of [0x00, 0xff]) {
      const generator = new Uuid7Generator(() => 1000, constant(byte));
      const made = Array.from({ length: 500 }, () => generator.next());
      expect([...made].sort()).toEqual(made);
      expect(new Set(made).size).toBe(500);
      for (const uuid of made) {
        expect(uuid).toMatch(V7);
      }
    }
  });

  it('keeps 100000 UUIDs with the real clock sorted, unique and valid', () => {
    const generator = new Uuid7Generator();
    const made = Array.from({ length: 100_000 }, () => generator.next());
    expect([...made].sort()).toEqual(made);
    expect(new Set(made).size).toBe(made.length);
    expect(made.every((uuid) => V7.test(uuid))).toBe(true);
  });

  it('draws a fresh value with room to count up in every new millisecond', () => {
    const generator = new Uuid7Generator(() => 5, constant(0xff));
    // The top bit of the 74 stays clear: rand_a begins with a 0 nibble bit.
    expect(generator.next()).toBe('00000000-0005-77ff-bfff-ffffffffffff');
  });

  it('moves to the next millisecond when the counter would overflow', () => {
    const generator = new Uuid7Generator(() => 7, constant(0xff));
    const state = generator as unknown as { random: bigint };
    generator.next();
    state.random = (1n << 74n) - 1n;
    const after = generator.next();
    expect(v7Milliseconds(after)).toBe(8);
    expect(after > '00000000-0007-7fff-bfff-ffffffffffff').toBe(true);
  });

  it('refuses a clock that is not a 48-bit millisecond count', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2 ** 48]) {
      expect(() => new Uuid7Generator(() => bad, nodeFill).next()).toThrow(RangeError);
    }
    expect(new Uuid7Generator(() => 2 ** 48 - 1, nodeFill).next()).toMatch(V7);
    expect(new Uuid7Generator(() => 0, nodeFill).next()).toMatch(V7);
    expect(new Uuid7Generator(() => 12.9, nodeFill).next().slice(0, 13)).toBe('00000000-000c');
  });

  it('uses crypto.getRandomValues and never Math.random', () => {
    const random = vi.spyOn(Math, 'random');
    const spy = vi.spyOn(crypto, 'getRandomValues');
    try {
      const generator = new Uuid7Generator();
      generator.next();
      generator.next();
      expect(spy).toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
      spy.mockRestore();
    }
  });
});

describe('v7Milliseconds', () => {
  it('reads a version 7 UUID, in either case, and nothing else', () => {
    expect(v7Milliseconds('01234567-89ab-7000-8000-000000000000')).toBe(0x0123_4567_89ab);
    expect(v7Milliseconds('01234567-89AB-7000-8000-000000000000')).toBe(0x0123_4567_89ab);
    expect(v7Milliseconds(uuidV4(nodeFill))).toBeUndefined();
    expect(v7Milliseconds('01234567-89ab-7000-c000-000000000000')).toBeUndefined();
    expect(v7Milliseconds('')).toBeUndefined();
    expect(v7Milliseconds('01234567-89ab-7000-8000-00000000000')).toBeUndefined();
  });
});

describe('formatForDisplay', () => {
  const uuid = '01234567-89ab-7cde-8f01-23456789abcd';
  it('applies case and hyphens independently', () => {
    expect(formatForDisplay(uuid, { uppercase: false, hyphens: true })).toBe(uuid);
    expect(formatForDisplay(uuid, { uppercase: true, hyphens: true })).toBe(uuid.toUpperCase());
    expect(formatForDisplay(uuid, { uppercase: false, hyphens: false })).toBe(
      '0123456789ab7cde8f0123456789abcd',
    );
    expect(formatForDisplay(uuid, { uppercase: true, hyphens: false })).toBe(
      '0123456789AB7CDE8F0123456789ABCD',
    );
  });
});

describe('generateBatch', () => {
  it('makes the count of version 4 or 7 UUIDs', () => {
    const generator = new Uuid7Generator();
    const four = generateBatch('v4', 10, generator);
    expect(four.ok && four.uuids).toHaveLength(10);
    expect(four.ok && four.uuids.every((uuid) => V4.test(uuid))).toBe(true);
    const seven = generateBatch('v7', 10, generator);
    expect(seven.ok && seven.uuids.every((uuid) => V7.test(uuid))).toBe(true);
  });

  it('continues the order of the generator from batch to batch', () => {
    const generator = new Uuid7Generator();
    const first = generateBatch('v7', MAX_COUNT, generator);
    const second = generateBatch('v7', MAX_COUNT, generator);
    if (!first.ok || !second.ok) {
      throw new Error('expected two batches');
    }
    const all = [...first.uuids, ...second.uuids];
    expect([...all].sort()).toEqual(all);
    expect(new Set(all).size).toBe(all.length);
  });

  it('refuses a count outside 1 to 1000', () => {
    const generator = new Uuid7Generator();
    for (const count of [0, -1, 1.5, Number.NaN, MAX_COUNT + 1]) {
      expect(generateBatch('v4', count, generator)).toEqual({
        ok: false,
        error: { code: 'count', min: MIN_COUNT, max: MAX_COUNT },
      });
    }
    expect(generateBatch('v4', MIN_COUNT, generator).ok).toBe(true);
    expect(generateBatch('v4', MAX_COUNT, generator).ok).toBe(true);
  });
});
