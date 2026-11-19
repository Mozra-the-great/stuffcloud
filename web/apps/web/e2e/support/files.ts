import { createHash } from 'node:crypto';

/** A file the tests upload: name, type and bytes. */
export interface Sample {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

/**
 * Deterministic, high-entropy bytes (xorshift32): no window of the output repeats, so a piece
 * of the file found in a request cannot be a coincidence, and every run uses the same file.
 */
export function noise(size: number, seed: number): Buffer {
  if (!Number.isInteger(size) || size < 0) {
    throw new RangeError(`size must be a whole number of bytes, got ${String(size)}`);
  }
  if (!Number.isInteger(seed) || seed === 0) {
    throw new RangeError('the seed must be a non-zero integer');
  }
  const out = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

/** A sample file of `size` random-looking bytes. */
export function sampleFile(name: string, size: number, seed: number): Sample {
  return { name, mimeType: 'application/octet-stream', buffer: noise(size, seed) };
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
