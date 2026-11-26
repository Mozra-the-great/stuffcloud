import { vi } from 'vitest';

type Listener = (event: { readonly data?: unknown }) => void;

/**
 * Loads a tool's `worker.ts` (the file a real worker runs: one `serveWorker(...)` call) as if it ran
 * in a worker scope, sends it the requests and returns what it posted back, in order. This is what
 * shows that the entry file wires the right task and input check, which no other test reaches
 * (the tests of a task call the function directly).
 */
export async function talkToWorker(
  load: () => Promise<unknown>,
  requests: readonly unknown[],
): Promise<unknown[]> {
  vi.resetModules();
  let listener: Listener | undefined;
  const replies: unknown[] = [];
  vi.stubGlobal('addEventListener', (type: string, handler: Listener): void => {
    if (type === 'message') {
      listener = handler;
    }
  });
  vi.stubGlobal('postMessage', (message: unknown): void => {
    replies.push(message);
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
