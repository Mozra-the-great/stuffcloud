/**
 * Random passwords. Every random number comes from `crypto.getRandomValues` (a cryptographically secure
 * generator) and is made uniform by rejection sampling, so no character is likelier than another.
 * The non-secure generator of the language is never used (a test scans the sources for it).
 */

export const LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const DIGITS = '0123456789';
export const SYMBOLS = '!#$%&()*+,-./:;<=>?@[]^_{|}~';
/** Characters that look alike in many fonts. */
export const AMBIGUOUS = 'Il1|O0o';

export const MIN_LENGTH = 4;
export const MAX_LENGTH = 128;
export const DEFAULT_LENGTH = 20;

export interface PasswordOptions {
  readonly length: number;
  readonly lower: boolean;
  readonly upper: boolean;
  readonly digits: boolean;
  readonly symbols: boolean;
  readonly excludeAmbiguous: boolean;
}

export type PasswordError =
  | { readonly code: 'no-sets' }
  | { readonly code: 'length'; readonly min: number; readonly max: number };

export type PasswordResult =
  | {
      readonly ok: true;
      readonly password: string;
      /** log2 of the number of different passwords these options can make (all equally likely). */
      readonly entropyBits: number;
      /** How many different characters may appear. */
      readonly poolSize: number;
    }
  | { readonly ok: false; readonly error: PasswordError };

/** Fills an array with random 32-bit numbers: `crypto.getRandomValues` fits, a test passes its own. */
export type FillRandom = (array: Uint32Array<ArrayBuffer>) => void;

const TWO_32 = 4_294_967_296;

function fillSecure(array: Uint32Array<ArrayBuffer>): void {
  crypto.getRandomValues(array);
}

/** A uniform integer from 0 up to, not including, `limit` (1 to 2^32). */
export function randomBelow(limit: number, fill: FillRandom = fillSecure): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > TWO_32) {
    throw new RangeError(`the limit must be a whole number from 1 to 2^32, got ${String(limit)}`);
  }
  // Numbers at or above the largest multiple of `limit` would favour the small results: draw again.
  const unbiased = TWO_32 - (TWO_32 % limit);
  const one = new Uint32Array(1);
  for (;;) {
    fill(one);
    const value = one[0] ?? 0;
    if (value < unbiased) {
      return value % limit;
    }
  }
}

/** The character sets the options select, after the ambiguous characters are removed (disjoint sets). */
export function selectedSets(options: PasswordOptions): string[] {
  const candidates = [
    options.lower ? LOWER : '',
    options.upper ? UPPER : '',
    options.digits ? DIGITS : '',
    options.symbols ? SYMBOLS : '',
  ];
  return candidates
    .map((set) =>
      options.excludeAmbiguous
        ? Array.from(set)
            .filter((char) => !AMBIGUOUS.includes(char))
            .join('')
        : set,
    )
    .filter((set) => set !== '');
}

/** log2 of a positive BigInt, to double precision. */
function log2(value: bigint): number {
  const bits = value.toString(2);
  const head = Math.min(bits.length, 53);
  return bits.length - head + Math.log2(Number.parseInt(bits.slice(0, head), 2));
}

/**
 * How many strings of `length` characters use every one of `sets` at least once (inclusion and exclusion
 * over the subsets of sets that may be missing). The generator draws uniformly from exactly these, so
 * log2 of the count is the entropy.
 */
export function countPasswords(sets: readonly string[], length: number): bigint {
  let total = 0n;
  for (let mask = 0; mask < 1 << sets.length; mask += 1) {
    let size = 0;
    let used = 0;
    sets.forEach((set, index) => {
      if ((mask & (1 << index)) !== 0) {
        size += set.length;
        used += 1;
      }
    });
    const term = BigInt(size) ** BigInt(length);
    total += (sets.length - used) % 2 === 0 ? term : -term;
  }
  return total;
}

/** Makes a password, or says why the options cannot make one. */
export function generatePassword(
  options: PasswordOptions,
  fill: FillRandom = fillSecure,
): PasswordResult {
  const sets = selectedSets(options);
  if (sets.length === 0) {
    return { ok: false, error: { code: 'no-sets' } };
  }
  const min = Math.max(MIN_LENGTH, sets.length);
  if (!Number.isInteger(options.length) || options.length < min || options.length > MAX_LENGTH) {
    return { ok: false, error: { code: 'length', min, max: MAX_LENGTH } };
  }
  const pool = Array.from(sets.join(''));
  for (;;) {
    const password = Array.from(
      { length: options.length },
      () => pool[randomBelow(pool.length, fill)] ?? '',
    ).join('');
    // Drawing again until every chosen kind of character is there keeps all valid passwords equally likely.
    if (sets.every((set) => Array.from(set).some((char) => password.includes(char)))) {
      return {
        ok: true,
        password,
        entropyBits: log2(countPasswords(sets, options.length)),
        poolSize: pool.length,
      };
    }
  }
}

export type Strength = 'weak' | 'fair' | 'strong' | 'very-strong';

/** A word for the entropy of a randomly generated password. */
export function strengthOf(entropyBits: number): Strength {
  if (entropyBits < 45) {
    return 'weak';
  }
  if (entropyBits < 65) {
    return 'fair';
  }
  return entropyBits < 90 ? 'strong' : 'very-strong';
}
