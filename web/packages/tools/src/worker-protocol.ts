/**
 * The messages between a {@link WorkerPool} and a worker that calls `serveWorker`. A job is
 * one `run` request; the worker answers with any number of `progress` replies and then exactly
 * one `result` or `error`. Cancelling a job terminates its worker (running WASM cannot be
 * interrupted), so there is no `cancel` message.
 */

/** How far a job is, in units the tool chooses (pages, bytes, files). */
export interface Progress {
  readonly completed: number;
  readonly total: number;
}

export interface RunRequest<I = unknown> {
  readonly type: 'run';
  readonly id: number;
  readonly input: I;
}

export type Reply<O = unknown> =
  | { readonly type: 'progress'; readonly id: number; readonly progress: Progress }
  | { readonly type: 'result'; readonly id: number; readonly output: O }
  | { readonly type: 'error'; readonly id: number; readonly message: string };

/** `0 <= completed <= total` and `total > 0`, all finite. */
export function isProgress(value: unknown): value is Progress {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { completed, total } = value as { readonly completed?: unknown; readonly total?: unknown };
  return (
    typeof completed === 'number' &&
    typeof total === 'number' &&
    Number.isFinite(completed) &&
    Number.isFinite(total) &&
    total > 0 &&
    completed >= 0 &&
    completed <= total
  );
}

/** The share of work done, from 0 to 1. */
export function progressFraction(progress: Progress): number {
  return progress.completed / progress.total;
}

function isSafeId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Whether `value` is a well-formed reply; anything else from a worker is a protocol error. */
export function isReply(value: unknown): value is Reply {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (!isSafeId(record['id'])) {
    return false;
  }
  switch (record['type']) {
    case 'progress':
      return isProgress(record['progress']);
    case 'result':
      return Object.hasOwn(record, 'output');
    case 'error':
      return typeof record['message'] === 'string';
    default:
      return false;
  }
}

export function isRunRequest(value: unknown): value is RunRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return record['type'] === 'run' && isSafeId(record['id']) && Object.hasOwn(record, 'input');
}
