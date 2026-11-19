import { vi, type Mock, type MockInstance } from 'vitest';
import { runPdfTask } from '../src/pdf/task.ts';
import type {
  PdfInput,
  PdfOutput,
  PdfRunner,
  ThumbBitmap,
  ThumbInput,
  ThumbOutput,
} from '../src/pdf/types.ts';

/** The ops runner of the tests: `run` can be replaced to script an answer. */
export interface OpsRunner extends PdfRunner<PdfInput, PdfOutput> {
  run: PdfRunner<PdfInput, PdfOutput>['run'];
  readonly calls: PdfInput[];
}

/** An ops runner that does the work right here (the real engine, no worker), for component tests. */
export function inProcessOps(): OpsRunner {
  const calls: PdfInput[] = [];
  return {
    calls,
    run: async (input, options) => {
      calls.push(input);
      if (options?.signal?.aborted === true) {
        throw new DOMException('aborted', 'AbortError');
      }
      return runPdfTask(input, {
        progress: (completed, total) => {
          options?.onProgress?.({ completed, total });
        },
      });
    },
    terminate: vi.fn(),
  };
}

export function fakeBitmap(
  width = 20,
  height = 30,
): ThumbBitmap & { readonly close: Mock<() => void> } {
  return { width, height, close: vi.fn<() => void>() };
}

/** A thumbnail runner that answers every job with a fake bitmap per page. */
export function fakeThumbs(): PdfRunner<ThumbInput, ThumbOutput> & {
  readonly calls: ThumbInput[];
  readonly bitmaps: ReturnType<typeof fakeBitmap>[];
} {
  const calls: ThumbInput[] = [];
  const bitmaps: ReturnType<typeof fakeBitmap>[] = [];
  return {
    calls,
    bitmaps,
    run: (input) => {
      calls.push(input);
      const thumbs = input.pages.map((page) => {
        const bitmap = fakeBitmap();
        bitmaps.push(bitmap);
        return { page, bitmap };
      });
      return Promise.resolve({ ok: true, thumbs });
    },
    terminate: vi.fn(),
  };
}

/** Object URLs, which jsdom does not have. */
export function stubObjectUrls(): { readonly created: Blob[]; readonly revoked: string[] } {
  const created: Blob[] = [];
  const revoked: string[] = [];
  let counter = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob): string => {
      created.push(blob);
      counter += 1;
      return `blob:test/${String(counter)}`;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (url: string): void => {
      revoked.push(url);
    },
  });
  return { created, revoked };
}

/** A 2D context that records what is drawn, for the canvases of jsdom (which has none). */
export function stubCanvas(): {
  readonly calls: string[];
  /** The stub itself: `mockReturnValue(null)` makes the browser refuse a 2D context. */
  readonly getContext: MockInstance<(contextId: string) => unknown>;
  restore: () => void;
} {
  const calls: string[] = [];
  const context = {
    save: (): void => void calls.push('save'),
    restore: (): void => void calls.push('restore'),
    translate: (x: number, y: number): void =>
      void calls.push(`translate ${String(x)} ${String(y)}`),
    rotate: (angle: number): void =>
      void calls.push(`rotate ${String(Math.round((angle * 180) / Math.PI))}`),
    drawImage: (_image: unknown, x: number, y: number): void =>
      void calls.push(`drawImage ${String(x)} ${String(y)}`),
  };
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation((): never => context as never) as unknown as MockInstance<
    (contextId: string) => unknown
  >;
  return {
    calls,
    getContext,
    restore: (): void => {
      getContext.mockRestore();
    },
  };
}

/** jsdom has no `Worker`, and a tool that needs workers shows a notice instead of itself without one. */
export function stubWorkerCapability(): void {
  vi.stubGlobal('Worker', vi.fn());
}

/** The item at `index`; a test that asks for one that is not there fails with a clear message. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`there is no item ${String(index)} (${String(items.length)} items)`);
  }
  return item;
}

/** The hidden file input of a tool page. */
export function fileInput(root: ParentNode): HTMLInputElement {
  const found = root.querySelector('input[type="file"]');
  if (!(found instanceof HTMLInputElement)) {
    throw new Error('no file input');
  }
  return found;
}
