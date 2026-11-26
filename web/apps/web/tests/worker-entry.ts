import { vi } from 'vitest';

type Listener = (event: { readonly data?: unknown }) => void;

/** One reply of a worker: the message and the buffers that moved with it instead of being copied. */
export interface WorkerReply {
  readonly message: unknown;
  readonly transfer: readonly unknown[] | undefined;
}

/**
 * Loads a tool's `worker.ts` (the file a real worker runs: one `serveWorker(...)` call) as if it ran
 * in a worker scope, sends it the requests and returns what it posted back, in order, with the
 * transfer list of each reply. This is what shows that the entry file wires the right task, input
 * check and transfer, which no other test reaches (the tests of a task call the function directly).
 */
export async function talkToWorkerDetailed(
  load: () => Promise<unknown>,
  requests: readonly unknown[],
): Promise<WorkerReply[]> {
  vi.resetModules();
  let listener: Listener | undefined;
  const replies: WorkerReply[] = [];
  vi.stubGlobal('addEventListener', (type: string, handler: Listener): void => {
    if (type === 'message') {
      listener = handler;
    }
  });
  vi.stubGlobal('postMessage', (message: unknown, transfer?: readonly unknown[]): void => {
    replies.push({ message, transfer });
  });
  try {
    await load();
    if (listener === undefined) {
      throw new Error('the worker file did not listen for messages');
    }
    for (const request of requests) {
      listener({ data: request });
    }
    await vi.waitFor(() => {
      if (replies.length < requests.length) {
        throw new Error(`${String(replies.length)} of ${String(requests.length)} replies so far`);
      }
    });
  } finally {
    vi.unstubAllGlobals();
  }
  return replies;
}

/** The messages a worker posted back, without their transfer lists. */
export async function talkToWorker(
  load: () => Promise<unknown>,
  requests: readonly unknown[],
): Promise<unknown[]> {
  const replies = await talkToWorkerDetailed(load, requests);
  return replies.map((reply) => reply.message);
}
