import { inspectFile } from './client.ts';
import { createOpsRunner, createThumbRunner } from './runners.ts';
import { ThumbnailStore } from './thumbs.svelte.ts';
import type { PdfInput, PdfIssue, PdfOutput, PdfRunner, ThumbInput, ThumbOutput } from './types.ts';

export type SessionState = 'empty' | 'reading' | 'ready';

/**
 * The one PDF a single-file tool works on: opens it in a worker, keeps its page count and rotations,
 * owns the workers and the page pictures, and lets go of all of it when the tool goes away.
 */
export class SingleDocument {
  state = $state<SessionState>('empty');
  file = $state.raw<File | undefined>();
  pageCount = $state(0);
  rotations = $state.raw<readonly number[]>([]);
  /** Why the last file could not be opened; cleared by the next successful open. */
  issue = $state.raw<PdfIssue | undefined>();
  /** Set when the worker itself failed (not the file). */
  crashed = $state(false);
  thumbs = $state.raw<ThumbnailStore | undefined>();

  #ops: PdfRunner<PdfInput, PdfOutput> | undefined;
  #thumbRunner: PdfRunner<ThumbInput, ThumbOutput> | undefined;
  #controller: AbortController | undefined;

  /** The pool for opening and building; started with the first use. */
  get ops(): PdfRunner<PdfInput, PdfOutput> {
    this.#ops ??= createOpsRunner();
    return this.#ops;
  }

  /** Opens `file`; resolves `true` when it is a usable PDF. A later `open` or `close` cancels this one. */
  async open(file: File): Promise<boolean> {
    this.close();
    const controller = new AbortController();
    this.#controller = controller;
    this.state = 'reading';
    this.file = file;
    this.issue = undefined;
    this.crashed = false;
    try {
      const result = await inspectFile(this.ops, file, { signal: controller.signal });
      if (controller.signal.aborted) {
        return false;
      }
      if (!result.ok) {
        this.issue = result.issue;
        this.state = 'empty';
        return false;
      }
      this.pageCount = result.pageCount;
      this.rotations = result.rotations;
      this.state = 'ready';
      return true;
    } catch {
      if (!controller.signal.aborted) {
        this.crashed = true;
        this.state = 'empty';
      }
      return false;
    }
  }

  /** Starts drawing the page pictures (once per opened file). */
  startThumbs(): void {
    const file = this.file;
    if (this.thumbs !== undefined || file === undefined || this.state !== 'ready') {
      return;
    }
    this.#thumbRunner ??= createThumbRunner();
    const store = new ThumbnailStore(this.#thumbRunner, file, this.pageCount);
    this.thumbs = store;
    store.start();
  }

  /** Forgets the file and its pictures; the workers stay for the next file. */
  close(): void {
    this.#controller?.abort();
    this.#controller = undefined;
    this.thumbs?.dispose();
    this.thumbs = undefined;
    this.state = 'empty';
    this.file = undefined;
    this.pageCount = 0;
    this.rotations = [];
    this.issue = undefined;
    this.crashed = false;
  }

  /** `close`, and the workers go too. */
  dispose(): void {
    this.close();
    this.#ops?.terminate();
    this.#thumbRunner?.terminate();
    this.#ops = undefined;
    this.#thumbRunner = undefined;
  }
}
