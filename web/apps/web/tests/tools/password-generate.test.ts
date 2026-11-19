import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AMBIGUOUS,
  DIGITS,
  LOWER,
  MAX_LENGTH,
  SYMBOLS,
  UPPER,
  countPasswords,
  generatePassword,
  randomBelow,
  selectedSets,
  strengthOf,
  type FillRandom,
  type PasswordOptions,
} from '../../src/tools/password/generate.ts';
import { appRoot } from '../helpers.ts';

const ALL: PasswordOptions = {
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
};

/** A fill that hands out the given numbers in order (the last one repeats). */
function sequence(values: readonly number[]): FillRandom {
  let index = 0;
  return (array) => {
    array[0] = values[Math.min(index, values.length - 1)] ?? 0;
    index += 1;
  };
}

describe('randomBelow', () => {
  it('takes the remainder of an unbiased draw', () => {
    expect(randomBelow(10, sequence([123]))).toBe(3);
    expect(randomBelow(1, sequence([987]))).toBe(0);
  });

  it('draws again for numbers that would favour the small results (the biased tail)', () => {
    // 2^32 % 3 = 1, so 4294967295 is the one number that is not a fair draw for 3.
    let draws = 0;
    const fill: FillRandom = (array) => {
      draws += 1;
      array[0] = draws === 1 ? 4_294_967_295 : 5;
    };
    expect(randomBelow(3, fill)).toBe(2);
    expect(draws).toBe(2);
    expect(randomBelow(3, sequence([4_294_967_294]))).toBe(2);
    expect(randomBelow(3, sequence([4_294_967_292]))).toBe(0);
  });

  it('accepts the largest limit, 2^32, and refuses limits outside 1 to 2^32', () => {
    expect(randomBelow(4_294_967_296, sequence([4_294_967_295]))).toBe(4_294_967_295);
    for (const bad of [0, -1, 1.5, Number.NaN, 4_294_967_297, Number.POSITIVE_INFINITY]) {
      expect(() => randomBelow(bad)).toThrow(RangeError);
    }
  });

  it('is uniform over a long run of the real generator (every result within 20 % of the mean)', () => {
    const counts = new Array<number>(7).fill(0);
    for (let index = 0; index < 14_000; index += 1) {
      const value = randomBelow(7);
      counts[value] = (counts[value] ?? 0) + 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(2000 * 0.8);
      expect(count).toBeLessThan(2000 * 1.2);
    }
  });
});

describe('selectedSets', () => {
  it('lists the chosen kinds in order', () => {
    expect(selectedSets(ALL)).toEqual([LOWER, UPPER, DIGITS, SYMBOLS]);
    expect(selectedSets({ ...ALL, lower: false, symbols: false })).toEqual([UPPER, DIGITS]);
    const none = { ...ALL, lower: false, upper: false, digits: false, symbols: false };
    expect(selectedSets(none)).toEqual([]);
  });

  it('removes the look-alike characters from every set', () => {
    const sets = selectedSets({ ...ALL, excludeAmbiguous: true }).join('');
    for (const char of AMBIGUOUS) {
      expect(sets).not.toContain(char);
    }
    expect(sets).toContain('a');
    expect(sets).toContain('9');
  });

  it('keeps the sets disjoint (the entropy count relies on it)', () => {
    const joined = selectedSets(ALL).join('');
    expect(new Set(joined).size).toBe(joined.length);
  });
});

describe('generatePassword', () => {
  it('makes a password of the asked length from the chosen kinds only', () => {
    for (const length of [4, 5, 20, 64, MAX_LENGTH]) {
      const result = generatePassword({ ...ALL, length });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.password).toHaveLength(length);
        expect(result.poolSize).toBe(LOWER.length + UPPER.length + DIGITS.length + SYMBOLS.length);
      }
    }
  });

  it('uses every chosen kind at least once (property over 300 passwords at the shortest length)', () => {
    for (let round = 0; round < 300; round += 1) {
      const result = generatePassword({ ...ALL, length: 4 });
      if (!result.ok) {
        throw new Error('a valid request failed');
      }
      expect(Array.from(result.password).some((c) => LOWER.includes(c))).toBe(true);
      expect(Array.from(result.password).some((c) => UPPER.includes(c))).toBe(true);
      expect(Array.from(result.password).some((c) => DIGITS.includes(c))).toBe(true);
      expect(Array.from(result.password).some((c) => SYMBOLS.includes(c))).toBe(true);
    }
  });

  it('draws again when a kind is missing, and keeps the second draw', () => {
    const options = { ...ALL, upper: false, symbols: false, length: 4 };
    // The pool is 36 characters: index 0 is "a", index 26 is "0".
    const result = generatePassword(options, sequence([0, 0, 0, 0, 0, 0, 0, 26]));
    expect(result).toMatchObject({ ok: true, password: 'aaa0' });
  });

  it('leaves out the look-alike characters on request', () => {
    for (let round = 0; round < 100; round += 1) {
      const result = generatePassword({ ...ALL, excludeAmbiguous: true, length: 60 });
      if (!result.ok) {
        throw new Error('a valid request failed');
      }
      for (const char of AMBIGUOUS) {
        expect(result.password).not.toContain(char);
      }
    }
  });

  it('uses only digits when only digits are chosen', () => {
    const result = generatePassword({
      ...ALL,
      lower: false,
      upper: false,
      symbols: false,
      length: 30,
    });
    expect(result.ok && /^\d{30}$/.test(result.password)).toBe(true);
  });

  it('says there is no kind of character to use', () => {
    const none = { ...ALL, lower: false, upper: false, digits: false, symbols: false };
    expect(generatePassword(none)).toEqual({ ok: false, error: { code: 'no-sets' } });
  });

  it('refuses lengths outside the range', () => {
    const bad = { ok: false, error: { code: 'length', min: 4, max: 128 } };
    expect(generatePassword({ ...ALL, length: 3 })).toEqual(bad);
    expect(generatePassword({ ...ALL, length: 129 })).toEqual(bad);
    expect(generatePassword({ ...ALL, length: Number.NaN }).ok).toBe(false);
    expect(generatePassword({ ...ALL, length: 8.5 }).ok).toBe(false);
    expect(generatePassword({ ...ALL, length: 4 }).ok).toBe(true);
    expect(generatePassword({ ...ALL, length: 128 }).ok).toBe(true);
  });

  it('reports the entropy of a single kind as length times log2 of its size', () => {
    const result = generatePassword({
      ...ALL,
      upper: false,
      digits: false,
      symbols: false,
      length: 20,
    });
    expect(result.ok && result.entropyBits).toBeCloseTo(20 * Math.log2(26), 9);
    expect(result.ok && result.poolSize).toBe(26);
  });

  it('reports less entropy than length times log2 of the pool when kinds are required', () => {
    const result = generatePassword({ ...ALL, length: 4 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entropyBits).toBeLessThan(4 * Math.log2(result.poolSize));
      expect(result.entropyBits).toBeGreaterThan(20);
    }
  });
});

describe('countPasswords', () => {
  it('counts by inclusion and exclusion, checked against brute force', () => {
    // Strings of 3 characters over {a, b, 1, 2} with a letter and a digit: 4^3 - 2^3 - 2^3.
    expect(countPasswords(['ab', '12'], 3)).toBe(48n);
    expect(countPasswords(['ab'], 5)).toBe(32n);
    let brute = 0n;
    const chars = ['a', 'b', 'c', '1', '2'];
    for (const x of chars) {
      for (const y of chars) {
        for (const z of chars) {
          for (const w of chars) {
            const text = x + y + z + w;
            if (/[abc]/.test(text) && /[12]/.test(text)) {
              brute += 1n;
            }
          }
        }
      }
    }
    expect(countPasswords(['abc', '12'], 4)).toBe(brute);
  });

  it('is exact for very large counts (128 characters, 4 kinds)', () => {
    const count = countPasswords(selectedSets(ALL), 128);
    const pool = BigInt(selectedSets(ALL).join('').length);
    expect(count < pool ** 128n).toBe(true);
    expect(count > (pool ** 128n * 99n) / 100n).toBe(true);
  });
});

describe('strengthOf', () => {
  it('has four levels with their boundaries', () => {
    expect(strengthOf(0)).toBe('weak');
    expect(strengthOf(44.9)).toBe('weak');
    expect(strengthOf(45)).toBe('fair');
    expect(strengthOf(64.9)).toBe('fair');
    expect(strengthOf(65)).toBe('strong');
    expect(strengthOf(89.9)).toBe('strong');
    expect(strengthOf(90)).toBe('very-strong');
    expect(strengthOf(500)).toBe('very-strong');
  });
});

describe('the sources of the password tool', () => {
  it('never use Math.random (a password needs a secure generator)', () => {
    for (const file of ['generate.ts', 'Tool.svelte', 'manifest.ts']) {
      const source = readFileSync(join(appRoot, 'src', 'tools', 'password', file), 'utf8');
      expect(source, file).not.toMatch(/Math\s*\.\s*random/);
    }
    const generator = readFileSync(
      join(appRoot, 'src', 'tools', 'password', 'generate.ts'),
      'utf8',
    );
    expect(generator).toContain('crypto.getRandomValues');
  });
});
