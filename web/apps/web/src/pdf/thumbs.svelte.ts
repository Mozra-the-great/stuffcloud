import type { PdfRunner, ThumbBitmap, ThumbInput, ThumbOutput } from './types.ts';

/** Width of the pictures in pixels: sharp at 160 CSS pixels on a screen with twice the pixels. */
export const THUMB_WIDTH = 320;

/** Pages per job: few enough that the first pictures come fast, many enough to read the file seldom. */
export function batchSize(pageCount: number): number {
  return Math.min(40, Math.max(8, Math.ceil(pageCount / 10)));
}

/** Zero-based page numbers split into jobs, in order. */
export function batches(pageCount: number): number[][] {
  const size = batchSize(pageCount);
  const result: number[][] = [];
  for (let start = 0; start < pageCount; start += size) {
    result.push(
      Array.from({ length: Math.min(size, pageCount - start) }, (_, offset) => start + offset),
    );
  }
  return result;
}

/**
 * The pictures of one PDF's pages, rendered in the background in the order of the pages. A page
 * whose picture cannot be drawn stays `undefined` (the page shows a placeholder); `failed` says
 * that a whole job did not come back, which the tool may mention.
 */
export class ThumbnailStore {
  #bitmaps = $state.raw<readonly (ThumbBitmap | undefined)[]>([]);
  #failed = $state(false);
  readonly #controller = new AbortController();
  readonly #runner: PdfRunner<ThumbInput, ThumbOutput>;
  readonly #file: Blob;
  readonly #pageCount: number;
  #disposed = false;

  constructor(runner: PdfRunner<ThumbInput, ThumbOutput>, file: Blob, pageCount: number) {
    this.#runner = runner;
    this.#file = file;
    this.#pageCount = pageCount;
    this.#bitmaps = Array.from({ length: pageCount }, () => undefined);
  }

  /** The picture of the zero-based page, once it is there. */
  bitmap(page: number): ThumbBitmap | undefined {
    return this.#bitmaps[page];
  }

  get failed(): boolean {
    return this.#failed;
  }

  /** Queues every job; the pool works through them in order. */
  start(): void {
    for (const pages of batches(this.#pageCount)) {
      void this.#load(pages);
    }
  }

  async #load(pages: readonly number[]): Promise<void> {
    try {
      const output = await this.#runner.run(
        { file: this.#file, pages, width: THUMB_WIDTH },
        { signal: this.#controller.signal },
      );
      if (!output.ok) {
        this.#failed = true;
        return;
      }
      if (this.#disposed) {
        for (const thumb of output.thumbs) {
          thumb.bitmap.close();
        }
        return;
      }
      const next = [...this.#bitmaps];
      for (const thumb of output.thumbs) {
        next[thumb.page]?.close();
        next[thumb.page] = thumb.bitmap;
      }
      this.#bitmaps = next;
    } catch {
      // Cancelled by `dispose`, or the worker died: the pages keep their placeholders.
      if (!this.#disposed) {
        this.#failed = true;
      }
    }
  }

  /** Stops the jobs and frees the pictures. */
  dispose(): void {
    this.#disposed = true;
    this.#controller.abort();
    for (const bitmap of this.#bitmaps) {
      bitmap?.close();
    }
    this.#bitmaps = this.#bitmaps.map(() => undefined);
  }
}
