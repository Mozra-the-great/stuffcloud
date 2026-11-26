import { describe, expect, it } from 'vitest';
import {
  AMBIGUOUS,
  DIGITS,
  LOWER,
  MAX_LENGTH,
  MIN_LENGTH,
  UPPER,
  countPasswords,
  generatePassword,
  randomBelow,
  selectedSets,
  type FillRandom,
  type PasswordOptions,
} from '../../src/tools/password/generate.ts';

const ALL: PasswordOptions = {
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
};

/** A source of "random" numbers that walks through 0, 1, 2, ... so every position of a pool is drawn. */
function counting(): FillRandom {
  let next = 0;
  return (array) => {
    for (let index = 0; index < array.length; index += 1) {
      array[index] = next;
      next += 1;
    }
  };
}

/** A fixed pseudo-random source (an LCG), so a password with every kind of character is found quickly and the same each run. */
function seeded(seed: number): FillRandom {
  let state = seed >>> 0;
  return (array) => {
    for (let index = 0; index < array.length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      array[index] = state;
    }
  };
}

describe('randomBelow: the limit', () => {
  it.each([0, -1, 1.5, Number.NaN, 2 ** 32 + 1, Number.POSITIVE_INFINITY])(
    'refuses %j with a message that names it',
    (limit) => {
      expect(() => randomBelow(limit)).toThrow(
        new RangeError(`the limit must be a whole number from 1 to 2^32, got ${String(limit)}`),
      );
    },
  );

  it('takes 1 and 2^32', () => {
    expect(randomBelow(1, () => undefined)).toBe(0);
    expect(randomBelow(2 ** 32, (array) => void array.fill(4_294_967_295))).toBe(4_294_967_295);
  });
});

describe('the character sets', () => {
  it('without the ambiguous characters are the same sets, joined without anything between the characters', () => {
    const [lower, upper, digits] = selectedSets({
      ...ALL,
      symbols: false,
      excludeAmbiguous: true,
    });
    const without = (set: string): string =>
      Array.from(set)
        .filter((char) => !AMBIGUOUS.includes(char))
        .join('');
    expect(lower).toBe(without(LOWER));
    expect(upper).toBe(without(UPPER));
    expect(digits).toBe(without(DIGITS));
    expect(digits).toBe('23456789');
    expect(lower).toBe('abcdefghijkmnpqrstuvwxyz');
    expect(upper).toBe('ABCDEFGHJKLMNPQRSTUVWXYZ');
  });

  it('are the whole sets when ambiguous characters are allowed, and only the chosen ones', () => {
    expect(selectedSets({ ...ALL, symbols: false, upper: false })).toEqual([LOWER, DIGITS]);
    expect(selectedSets({ ...ALL, lower: false, digits: false, symbols: false })).toEqual([UPPER]);
    expect(
      selectedSets({ ...ALL, lower: false, upper: false, digits: false, symbols: false }),
    ).toEqual([]);
  });

  it('leave no password character outside them, with the ambiguous ones excluded too', () => {
    const options = { ...ALL, length: 128, excludeAmbiguous: true };
    const result = generatePassword(options, counting());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const allowed = new Set(Array.from(selectedSets(options).join('')));
      expect(result.password).toHaveLength(128);
      for (const char of Array.from(result.password)) {
        expect(allowed.has(char), char).toBe(true);
      }
    }
  });
});

describe('generatePassword: the length', () => {
  it('is at least four, and at least one per chosen kind, and at most 128', () => {
    const only = { ...ALL, upper: false, digits: false, symbols: false };
    expect(generatePassword({ ...only, length: MIN_LENGTH - 1 }, counting())).toEqual({
      ok: false,
      error: { code: 'length', min: MIN_LENGTH, max: MAX_LENGTH },
    });
    expect(generatePassword({ ...only, length: 1 }, counting())).toEqual({
      ok: false,
      error: { code: 'length', min: MIN_LENGTH, max: MAX_LENGTH },
    });
    expect(generatePassword({ ...only, length: MIN_LENGTH }, counting()).ok).toBe(true);
    expect(generatePassword({ ...ALL, length: MIN_LENGTH - 1 }, counting())).toMatchObject({
      ok: false,
      error: { min: 4 },
    });
    expect(generatePassword({ ...ALL, length: MIN_LENGTH }, seeded(1)).ok).toBe(true);
    expect(generatePassword({ ...ALL, length: MAX_LENGTH }, seeded(2)).ok).toBe(true);
    expect(generatePassword({ ...ALL, length: MAX_LENGTH + 1 }, counting())).toEqual({
      ok: false,
      error: { code: 'length', min: 4, max: 128 },
    });
    expect(generatePassword({ ...ALL, length: 10.5 }, counting()).ok).toBe(false);
    expect(generatePassword({ ...ALL, length: Number.NaN }, counting()).ok).toBe(false);
  });
});

describe('countPasswords: strings that use every set at least once', () => {
  it('is inclusion and exclusion over the sets that may be missing', () => {
    expect(countPasswords(['a'], 3)).toBe(1n);
    expect(countPasswords(['ab'], 3)).toBe(8n);
    expect(countPasswords(['ab', 'cd'], 2)).toBe(8n);
    expect(countPasswords(['ab', 'cd'], 3)).toBe(48n);
    expect(countPasswords(['a', 'b', 'c'], 3)).toBe(6n);
    expect(countPasswords(['a', 'b', 'c'], 4)).toBe(36n);
    expect(countPasswords(['a', 'bc', 'def'], 3)).toBe(36n);
    expect(countPasswords(['a', 'b'], 1)).toBe(0n);
    expect(countPasswords(['a', 'b', 'c', 'd'], 4)).toBe(24n);
  });

  it('has exactly one string of no length and no set, and none of no length with a set', () => {
    expect(countPasswords([], 0)).toBe(1n);
    expect(countPasswords(['a'], 0)).toBe(0n);
    expect(countPasswords(['ab', 'cd'], 0)).toBe(0n);
    expect(countPasswords([], 5)).toBe(0n);
  });

  it('agrees with counting by hand for small cases', () => {
    const hand = (sets: readonly string[], length: number): bigint => {
      const alphabet = Array.from(sets.join(''));
      let total = 0n;
      const walk = (prefix: string): void => {
        if (prefix.length === length) {
          if (sets.every((set) => Array.from(set).some((char) => prefix.includes(char)))) {
            total += 1n;
          }
          return;
        }
        for (const char of alphabet) {
          walk(prefix + char);
        }
      };
      walk('');
      return total;
    };
    for (const sets of [['a'], ['ab', 'c'], ['ab', 'cd', 'e'], ['a', 'b', 'c', 'd']]) {
      for (let length = 0; length <= 5; length += 1) {
        expect(countPasswords(sets, length), `${sets.join(',')} ${String(length)}`).toBe(
          hand(sets, length),
        );
      }
    }
  });
});
