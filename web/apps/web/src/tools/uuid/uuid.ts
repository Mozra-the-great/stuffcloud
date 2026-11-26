/**
 * UUIDs, version 4 (random) and version 7 (a millisecond timestamp, then random bits that count up
 * within a millisecond, RFC 9562). Every random bit comes from `crypto.getRandomValues`, which also
 * works outside a secure context (`crypto.randomUUID` does not).
 */

export type UuidVersion = 'v4' | 'v7';

export const UUID_VERSIONS: readonly UuidVersion[] = ['v4', 'v7'];

export const MIN_COUNT = 1;
export const MAX_COUNT = 1000;
export const DEFAULT_COUNT = 5;

/** Fills a byte array with random bytes: `crypto.getRandomValues` fits, a test passes its own. */
export type FillBytes = (bytes: Uint8Array<ArrayBuffer>) => void;

export function fillSecure(bytes: Uint8Array<ArrayBuffer>): void {
  crypto.getRandomValues(bytes);
}

/** The 16 bytes as `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (lowercase). */
export function formatUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new RangeError(`a UUID has 16 bytes, got ${String(bytes.length)}`);
  }
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Version 4: 122 random bits, the version and variant bits set. */
export function uuidV4(fill: FillBytes = fillSecure): string {
  const bytes = new Uint8Array(16);
  fill(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/** The 74 random bits of a version 7 UUID: `rand_a` (12 bits) and `rand_b` (62 bits). */
const RANDOM_BITS = 74n;
const RANDOM_LIMIT = 1n << RANDOM_BITS;
/** Bits of `rand_b`. */
const RAND_B_BITS = 62n;
const RAND_B_MASK = (1n << RAND_B_BITS) - 1n;
/** The timestamp is 48 bits of Unix milliseconds. */
const MAX_MILLISECONDS = 2 ** 48 - 1;

/**
 * Adds `step` to the 74 random bits; `undefined` when they would overflow (the caller then moves on
 * to the next millisecond).
 */
export function advance(random: bigint, step: bigint): bigint | undefined {
  const next = random + step;
  return next >= RANDOM_LIMIT ? undefined : next;
}

function toBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/** Puts a timestamp and 74 random bits into a version 7 UUID. */
export function formatV7(milliseconds: number, random: bigint): string {
  const bytes = new Uint8Array(16);
  let rest = milliseconds;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  const randA = Number(random >> RAND_B_BITS);
  const randB = random & RAND_B_MASK;
  bytes[6] = 0x70 | (randA >> 8);
  bytes[7] = randA & 0xff;
  bytes[8] = 0x80 | Number(randB >> 56n);
  bytes.set(
    Array.from({ length: 7 }, (_, offset) => Number((randB >> BigInt((6 - offset) * 8)) & 0xffn)),
    9,
  );
  return formatUuid(bytes);
}

/**
 * A version 7 generator. UUIDs from one generator are strictly increasing, also inside one
 * millisecond (the random part counts up by a random step) and when the clock steps back (the
 * generator keeps the last timestamp), so they sort in the order they were made.
 */
export class Uuid7Generator {
  private milliseconds = -1;
  private random = 0n;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly fill: FillBytes = fillSecure,
  ) {}

  /** The random bits of a new millisecond; the top bit stays clear, so there is room to count up. */
  private fresh(): bigint {
    const bytes = new Uint8Array(10);
    this.fill(bytes);
    return toBigInt(bytes) & (RANDOM_LIMIT / 2n - 1n);
  }

  /** A random step from 1 to 2^20 for the counter inside a millisecond. */
  private step(): bigint {
    const bytes = new Uint8Array(3);
    this.fill(bytes);
    return (toBigInt(bytes) & 0xfffffn) + 1n;
  }

  next(): string {
    const clock = Math.floor(this.now());
    if (!Number.isFinite(clock) || clock < 0 || clock > MAX_MILLISECONDS) {
      throw new RangeError(`the clock gives ${String(clock)}, not a 48-bit millisecond count`);
    }
    if (clock > this.milliseconds) {
      this.milliseconds = clock;
      this.random = this.fresh();
    } else {
      const next = advance(this.random, this.step());
      if (next === undefined) {
        // Cannot happen with a fresh value below 2^73 and steps up to 2^20 in any realistic time;
        // the rule is still kept, so the order never breaks.
        this.milliseconds += 1;
        this.random = this.fresh();
      } else {
        this.random = next;
      }
    }
    return formatV7(this.milliseconds, this.random);
  }
}

/** Reads the Unix milliseconds out of a version 7 UUID; `undefined` when it is not one. */
export function v7Milliseconds(uuid: string): number | undefined {
  const text = uuid.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) {
    return undefined;
  }
  // The first 48 bits: the groups of 8 and 4 digits.
  return Number.parseInt(`${text.slice(0, 8)}${text.slice(9, 13)}`, 16);
}

export interface FormatOptions {
  readonly uppercase: boolean;
  readonly hyphens: boolean;
}

export function formatForDisplay(uuid: string, options: FormatOptions): string {
  const text = options.hyphens ? uuid : uuid.replaceAll('-', '');
  return options.uppercase ? text.toUpperCase() : text;
}

export interface CountError {
  readonly code: 'count';
  readonly min: number;
  readonly max: number;
}

export type BatchResult =
  | { readonly ok: true; readonly uuids: readonly string[] }
  | { readonly ok: false; readonly error: CountError };

/** `count` UUIDs of the version; version 7 ones come from `generator` and so continue its order. */
export function generateBatch(
  version: UuidVersion,
  count: number,
  generator: Uuid7Generator,
  fill: FillBytes = fillSecure,
): BatchResult {
  if (!Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) {
    return { ok: false, error: { code: 'count', min: MIN_COUNT, max: MAX_COUNT } };
  }
  const uuids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    uuids.push(version === 'v4' ? uuidV4(fill) : generator.next());
  }
  return { ok: true, uuids };
}
