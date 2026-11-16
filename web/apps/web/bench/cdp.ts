/**
 * A minimal Chrome DevTools Protocol client (no dependency: Node's global `WebSocket` is enough).
 * Only request/response calls are supported; events are ignored.
 */
import type { Metrics } from './stats.ts';

/** The part of a WebSocket the client uses; Node's global `WebSocket` satisfies it. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

interface Pending {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private readonly socket: SocketLike;

  constructor(socket: SocketLike) {
    this.socket = socket;
    socket.onmessage = (event): void => {
      this.handle(event.data);
    };
    socket.onclose = (): void => {
      this.rejectAll(new Error('DevTools connection closed'));
    };
  }

  /** Calls a protocol method; rejects with the browser's message when it answers with an error. */
  async call(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const message = JSON.stringify(
      sessionId === undefined ? { id, method, params } : { id, method, params, sessionId },
    );
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(message);
    });
  }

  close(): void {
    this.socket.close();
    this.rejectAll(new Error('DevTools connection closed'));
  }

  private handle(data: unknown): void {
    if (typeof data !== 'string') {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message['id'] !== 'number') {
      return;
    }
    const entry = this.pending.get(message['id']);
    if (entry === undefined) {
      return;
    }
    this.pending.delete(message['id']);
    const failure = message['error'];
    if (isRecord(failure)) {
      const text = failure['message'];
      entry.reject(new Error(typeof text === 'string' ? text : 'DevTools error'));
    } else {
      entry.resolve(message['result']);
    }
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }
}

/** Reads the answer of `Performance.getMetrics` into a name to value map. */
export function parseMetrics(result: unknown): Metrics {
  const metrics: Record<string, number> = {};
  const list = isRecord(result) ? result['metrics'] : undefined;
  if (!Array.isArray(list)) {
    throw new Error('Performance.getMetrics returned no metrics');
  }
  for (const item of list as unknown[]) {
    if (isRecord(item) && typeof item['name'] === 'string' && typeof item['value'] === 'number') {
      metrics[item['name']] = item['value'];
    }
  }
  return metrics;
}

/** The value of `result.<field>` when it is a string; throws otherwise. */
export function stringField(result: unknown, field: string): string {
  const value = isRecord(result) ? result[field] : undefined;
  if (typeof value !== 'string') {
    throw new Error(`DevTools answer has no string field "${field}"`);
  }
  return value;
}

/** The `result.value` of `Runtime.evaluate` (called with `returnByValue`); throws on a page exception. */
export function evaluated(result: unknown): unknown {
  if (!isRecord(result)) {
    throw new Error('Runtime.evaluate returned nothing');
  }
  const exception = result['exceptionDetails'];
  if (isRecord(exception)) {
    const text = exception['text'];
    const detail = isRecord(exception['exception'])
      ? exception['exception']['description']
      : undefined;
    throw new Error(
      `page exception: ${typeof detail === 'string' ? detail : typeof text === 'string' ? text : 'unknown'}`,
    );
  }
  const inner = result['result'];
  return isRecord(inner) ? inner['value'] : undefined;
}
