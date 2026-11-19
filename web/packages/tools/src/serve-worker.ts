import { isProgress, isRunRequest, type Reply } from './worker-protocol.ts';

/** The slice of a worker's global scope that {@link serveWorker} uses. */
export interface WorkerScope {
  postMessage(message: unknown, transfer?: object[]): void;
  addEventListener(
    type: 'message',
    listener: (event: { readonly data?: unknown; readonly origin?: string }) => void,
  ): void;
}

/** What a task handler can report while it runs. */
export interface TaskContext {
  /** `completed` of `total` units are done; throws a `RangeError` for numbers that make no sense. */
  readonly progress: (completed: number, total: number) => void;
}

export interface ServeOptions<I, O> {
  /**
   * Checks the input of a job before the handler sees it (what arrives through `postMessage`
   * is only typed by trust). A job whose input is refused fails with an error reply.
   */
  readonly accepts?: (input: unknown) => input is I;
  /** Buffers of the output that are moved to the page instead of copied. */
  readonly transfer?: (output: O) => object[];
  /** Defaults to the worker's own global scope. */
  readonly scope?: WorkerScope;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message === '' ? error.name : error.message;
  }
  return typeof error === 'string' && error !== '' ? error : 'the task failed';
}

/**
 * Runs inside a worker: answers every `run` request of the pool by calling `handler` and
 * reports the result, the progress or the error. A thrown error becomes an `error` reply, so a
 * failing job rejects its promise without taking the worker down.
 *
 * ```ts
 * // worker.ts
 * serveWorker<Input, Output>((input, { progress }) => { ... });
 * ```
 */
export function serveWorker<I, O>(
  handler: (input: I, context: TaskContext) => O | Promise<O>,
  options: ServeOptions<I, O> = {},
): void {
  const scope = options.scope ?? (globalThis as unknown as WorkerScope);
  const reply = (message: Reply, transfer?: object[]): void => {
    scope.postMessage(message, transfer);
  };
  scope.addEventListener('message', (event) => {
    // A dedicated worker only hears its parent, and its events carry an empty origin. A message
    // with an origin comes from a window: `serveWorker` was called in a page, which must not
    // let other pages run tasks.
    if (event.origin !== undefined && event.origin !== '') {
      return;
    }
    const request: unknown = event.data;
    if (!isRunRequest(request)) {
      return;
    }
    const { id, input } = request;
    const context: TaskContext = {
      progress: (completed, total): void => {
        const progress = { completed, total };
        if (!isProgress(progress)) {
          throw new RangeError(
            `progress ${String(completed)} of ${String(total)} is not 0 <= completed <= total with total > 0`,
          );
        }
        reply({ type: 'progress', id, progress });
      },
    };
    void (async (): Promise<void> => {
      try {
        if (options.accepts !== undefined && !options.accepts(input)) {
          throw new TypeError('the worker received input it cannot work with');
        }
        const output = await handler(input as I, context);
        reply({ type: 'result', id, output }, options.transfer?.(output));
      } catch (error: unknown) {
        reply({ type: 'error', id, message: messageOf(error) });
      }
    })();
  });
}
