import type { TaskContext } from '@stuffcloud/tools';
import { ALGORITHMS, createHasher, toHex, type Digests } from './digest.ts';

/** The file to hash; the worker reads it piece by piece (`Blob.slice`), so it is never held in memory whole. */
export interface Input {
  readonly file: Blob;
}

export interface Output {
  readonly size: number;
  readonly digests: Digests;
}

/** The file is read and hashed in pieces of this size (in bytes); progress is reported after each. */
export const CHUNK_SIZE = 4 * 1024 * 1024;

export function isInput(value: unknown): value is Input {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly file?: unknown }).file instanceof Blob
  );
}

/** The work of the tool: every digest of the file in one pass. It runs in the worker, so it must not touch the DOM. */
export async function runTask({ file }: Input, { progress }: TaskContext): Promise<Output> {
  const hashers = ALGORITHMS.map((algorithm) => [algorithm, createHasher(algorithm)] as const);
  // The progress total must be positive, also for an empty file.
  const total = Math.max(file.size, 1);
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
    for (const [, hasher] of hashers) {
      hasher.update(chunk);
    }
    progress(Math.min(offset + chunk.length, total), total);
  }
  progress(total, total);
  const digests = Object.fromEntries(
    hashers.map(([algorithm, hasher]) => [algorithm, toHex(hasher.digest())]),
  ) as Digests;
  return { size: file.size, digests };
}
