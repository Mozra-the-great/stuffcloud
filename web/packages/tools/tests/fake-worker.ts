import type { WorkerEventLike, WorkerLike, WorkerScope } from '../src/index.ts';

type EventName = 'message' | 'error' | 'messageerror';

/** A worker the test drives by hand: records what the pool sends, emits what the test says. */
export class FakeWorker implements WorkerLike {
  readonly sent: { readonly message: unknown; readonly transfer: object[] | undefined }[] = [];
  terminated = false;
  failNextPost: Error | undefined;
  readonly #listeners: Record<EventName, ((event: WorkerEventLike) => void)[]> = {
    message: [],
    error: [],
    messageerror: [],
  };

  postMessage(message: unknown, transfer?: object[]): void {
    if (this.failNextPost !== undefined) {
      const error = this.failNextPost;
      this.failNextPost = undefined;
      throw error;
    }
    this.sent.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: EventName, listener: (event: WorkerEventLike) => void): void {
    this.#listeners[type].push(listener);
  }

  emit(type: EventName, event: WorkerEventLike = {}): void {
    for (const listener of this.#listeners[type]) {
      listener(event);
    }
  }

  /** The worker answers with `data`. */
  reply(data: unknown): void {
    this.emit('message', { data });
  }

  /** The id of the job the pool sent last. */
  lastId(): number {
    const last = this.sent.at(-1)?.message as { readonly id: number } | undefined;
    if (last === undefined) {
      throw new Error('the pool has not sent anything yet');
    }
    return last.id;
  }
}

/** Creates fake workers and remembers them in start order. */
export class Factory {
  readonly workers: FakeWorker[] = [];
  failCreate: Error | undefined;

  readonly create = (): WorkerLike => {
    if (this.failCreate !== undefined) {
      throw this.failCreate;
    }
    const worker = new FakeWorker();
    this.workers.push(worker);
    return worker;
  };
}

/** A worker-side scope the test can push messages into; replies are collected. */
export class FakeScope implements WorkerScope {
  readonly posted: { readonly message: unknown; readonly transfer: object[] | undefined }[] = [];
  #listener: ((event: { readonly data?: unknown; readonly origin?: string }) => void) | undefined;

  postMessage(message: unknown, transfer?: object[]): void {
    this.posted.push({ message, transfer });
  }

  addEventListener(
    _type: 'message',
    listener: (event: { readonly data?: unknown; readonly origin?: string }) => void,
  ): void {
    this.#listener = listener;
  }

  deliver(data: unknown, origin?: string): void {
    if (this.#listener === undefined) {
      throw new Error('serveWorker has not registered a listener');
    }
    this.#listener(origin === undefined ? { data } : { data, origin });
  }
}

/** Lets promise continuations run. */
export async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await Promise.resolve();
  }
}
