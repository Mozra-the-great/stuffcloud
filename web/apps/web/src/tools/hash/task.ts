import type { TaskContext } from '@stuffcloud/tools';
import { ALGORITHMS, createHasher, toHex, type Digests } from './digest.ts';

/** The file to hash; it is read from the worker, chunk by chunk, so it is never held in memory whole. */
export interface Input {
  readonly file: Blob;
}

export interface Output {
  readonly size: number;
  readonly digests: Digests;
}

/** Progress is reported at most this often (in bytes), so a big file does not flood the page with messages. */
export const PROGRESS_STEP = 4 * 1024 * 1024;

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
  const reader = file.stream().getReader();
  let done = 0;
  let reported = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    for (const [, hasher] of hashers) {
      hasher.update(chunk.value);
    }
    done += chunk.value.length;
    if (done - reported >= PROGRESS_STEP) {
      reported = done;
      progress(Math.min(done, total), total);
    }
  }
  progress(total, total);
  const digests = Object.fromEntries(
    hashers.map(([algorithm, hasher]) => [algorithm, toHex(hasher.digest())]),
  ) as Digests;
  return { size: file.size, digests };
}
