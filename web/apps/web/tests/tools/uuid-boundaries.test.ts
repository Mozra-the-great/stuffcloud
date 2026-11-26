import { describe, expect, it } from 'vitest';
import {
  UUID_VERSIONS,
  Uuid7Generator,
  formatUuid,
  uuidV4,
  v7Milliseconds,
  type FillBytes,
} from '../../src/tools/uuid/uuid.ts';

/** Byte `i` of every request is `i + 1`: the same input for every run, so the output can be written down. */
const counting: FillBytes = (bytes) => {
  bytes.forEach((_, index) => {
    bytes[index] = index + 1;
  });
};

describe('the versions', () => {
  it('are 4 and 7', () => {
    expect([...UUID_VERSIONS]).toEqual(['v4', 'v7']);
  });
});

describe('formatUuid', () => {
  it('writes every byte as two lowercase hex digits and groups them 8-4-4-4-12', () => {
    expect(
      formatUuid(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])),
    ).toBe('00010203-0405-0607-0809-0a0b0c0d0e0f');
    expect(formatUuid(new Uint8Array(16).fill(255))).toBe('ffffffff-ffff-ffff-ffff-ffffffffffff');
    expect(formatUuid(new Uint8Array(16))).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('refuses any other length and says which', () => {
    expect(() => formatUuid(new Uint8Array(15))).toThrow(
      new RangeError('a UUID has 16 bytes, got 15'),
    );
    expect(() => formatUuid(new Uint8Array(17))).toThrow(
      new RangeError('a UUID has 16 bytes, got 17'),
    );
    expect(() => formatUuid(new Uint8Array(0))).toThrow(
      new RangeError('a UUID has 16 bytes, got 0'),
    );
  });
});

describe('uuidV4', () => {
  it('keeps the random bits and sets the version and variant bits', () => {
    expect(uuidV4(counting)).toBe('01020304-0506-4708-890a-0b0c0d0e0f10');
    const ones: FillBytes = (bytes) => {
      bytes.fill(0xff);
    };
    expect(uuidV4(ones)).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    const zeros: FillBytes = (bytes) => {
      bytes.fill(0);
    };
    expect(uuidV4(zeros)).toBe('00000000-0000-4000-8000-000000000000');
  });
});

describe('Uuid7Generator with a fixed source of bits', () => {
  it('writes the clock into the first 48 bits and the random bits after the version', () => {
    expect(new Uuid7Generator(() => 0, counting).next()).toBe(
      '00000000-0000-7408-8304-05060708090a',
    );
    expect(new Uuid7Generator(() => 1, counting).next()).toBe(
      '00000000-0001-7408-8304-05060708090a',
    );
    expect(new Uuid7Generator(() => 123_456_789, counting).next()).toBe(
      '0000075b-cd15-7408-8304-05060708090a',
    );
  });

  it('counts up inside a millisecond by the step it reads', () => {
    const generator = new Uuid7Generator(() => 5, counting);
    expect(generator.next()).toBe('00000000-0005-7408-8304-05060708090a');
    expect(generator.next()).toBe('00000000-0005-7408-8304-050607090b0e');
  });

  it('starts a new random value when the clock moves on, and keeps the last time when it steps back', () => {
    let clock = 10;
    const generator = new Uuid7Generator(() => clock, counting);
    expect(generator.next()).toBe('00000000-000a-7408-8304-05060708090a');
    clock = 11;
    expect(generator.next()).toBe('00000000-000b-7408-8304-05060708090a');
    clock = 3;
    expect(generator.next().startsWith('00000000-000b-')).toBe(true);
  });

  it('accepts a clock from 0 to 2^48 - 1 and a fraction of a millisecond is cut off', () => {
    expect(
      new Uuid7Generator(() => 2 ** 48 - 1, counting).next().startsWith('ffffffff-ffff-7'),
    ).toBe(true);
    expect(new Uuid7Generator(() => 7.9, counting).next().startsWith('00000000-0007-7')).toBe(true);
  });

  it.each([
    [-1, '-1'],
    [2 ** 48, '281474976710656'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
  ])('refuses the clock %j and says what it gave', (clock, shown) => {
    expect(() => new Uuid7Generator(() => clock, counting).next()).toThrow(
      new RangeError(`the clock gives ${shown}, not a 48-bit millisecond count`),
    );
  });
});

describe('v7Milliseconds', () => {
  const valid = '0000075b-cd15-7408-8304-05060708090a';

  it('reads the clock of a version 7 UUID, in either case', () => {
    expect(v7Milliseconds(valid)).toBe(123_456_789);
    expect(v7Milliseconds(valid.toUpperCase())).toBe(123_456_789);
    expect(v7Milliseconds('ffffffff-ffff-7fff-bfff-ffffffffffff')).toBe(2 ** 48 - 1);
  });

  it('wants the whole text to be one: nothing before it, nothing after it', () => {
    expect(v7Milliseconds(` ${valid}`)).toBeUndefined();
    expect(v7Milliseconds(`x${valid}`)).toBeUndefined();
    expect(v7Milliseconds(`${valid} `)).toBeUndefined();
    expect(v7Milliseconds(`${valid}0`)).toBeUndefined();
    expect(v7Milliseconds(`${valid}\n`)).toBeUndefined();
  });

  it('wants version 7 and a variant of 8 to b', () => {
    expect(v7Milliseconds('0000075b-cd15-4408-8304-05060708090a')).toBeUndefined();
    expect(v7Milliseconds('0000075b-cd15-6408-8304-05060708090a')).toBeUndefined();
    expect(v7Milliseconds('0000075b-cd15-7408-7304-05060708090a')).toBeUndefined();
    expect(v7Milliseconds('0000075b-cd15-7408-c304-05060708090a')).toBeUndefined();
    for (const variant of ['8', '9', 'a', 'b']) {
      expect(v7Milliseconds(`0000075b-cd15-7408-${variant}304-05060708090a`)).toBe(123_456_789);
    }
  });

  it('wants the right number of digits in every group', () => {
    expect(v7Milliseconds('000075b-cd15-7408-8304-05060708090a')).toBeUndefined();
    expect(v7Milliseconds('0000075b-cd1-7408-8304-05060708090a')).toBeUndefined();
    expect(v7Milliseconds('0000075b-cd15-740-8304-05060708090a')).toBeUndefined();
    expect(v7Milliseconds('0000075b-cd15-7408-830-05060708090a')).toBeUndefined();
    expect(v7Milliseconds('0000075b-cd15-7408-8304-0506070809a')).toBeUndefined();
    expect(v7Milliseconds('0000075b-cd15-7408-8304-05060708090ab')).toBeUndefined();
    expect(v7Milliseconds('0000075g-cd15-7408-8304-05060708090a')).toBeUndefined();
    expect(v7Milliseconds('')).toBeUndefined();
  });
});
