import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_TOTAL_INPUT_BYTES } from '../src/pdf/limits.ts';
import { isThumbInput, MAX_THUMBS_PER_JOB } from '../src/pdf/thumb-input.ts';
import {
  renderThumbnails,
  thumbTransfer,
  type CanvasLike,
  type ThumbnailDeps,
} from '../src/pdf/thumbnails.ts';
import type { ThumbOutput } from '../src/pdf/types.ts';
import { makeEncryptedPdf, makePdf } from './pdf-fixtures.ts';

/**
 * pdf.js runs for real here (its own worker code in this thread, as in `thumbs-worker.ts`); only
 * the drawing surface is replaced by one that records what is drawn.
 */
beforeAll(() => {
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;
});

interface Recorded {
  readonly canvases: CanvasLike[];
  readonly calls: Set<string>;
  readonly closed: number[];
}

function recorder(): { deps: ThumbnailDeps; recorded: Recorded } {
  const recorded: Recorded = { canvases: [], calls: new Set(), closed: [] };
  const deps: ThumbnailDeps = {
    createCanvas(width, height) {
      const canvas: CanvasLike = {
        width,
        height,
        getContext: () => context,
        transferToImageBitmap: () => ({
          width: canvas.width,
          height: canvas.height,
          close: (): void => {
            recorded.closed.push(canvas.width);
          },
        }),
      };
      const context: unknown = new Proxy(
        function noop(): void {
          // A callable target: the context is called as well as read.
        },
        {
          get(_target, key) {
            if (key === 'canvas') {
              return canvas;
            }
            recorded.calls.add(String(key));
            return context;
          },
          set: () => true,
          apply: () => context,
        },
      );
      recorded.canvases.push(canvas);
      return canvas;
    },
  };
  return { deps, recorded };
}

const progress = (): void => undefined;

function file(bytes: Uint8Array<ArrayBuffer>): Blob {
  return new Blob([bytes], { type: 'application/pdf' });
}

describe('renderThumbnails', () => {
  it('draws the asked pages at the asked width, in order, on a white page', async () => {
    const { deps, recorded } = recorder();
    const steps = vi.fn();
    const output = await renderThumbnails(
      { file: file(await makePdf(4)), pages: [3, 0, 2], width: 320 },
      deps,
      { progress: steps },
    );
    if (!output.ok) {
      throw new Error(output.issue);
    }
    expect(output.thumbs.map((thumb) => thumb.page)).toEqual([3, 0, 2]);
    // Page n is 100 + n points wide and 200 high: scaled to 320 pixels wide.
    expect(output.thumbs.map((thumb) => thumb.bitmap.width)).toEqual([320, 320, 320]);
    expect(output.thumbs.map((thumb) => thumb.bitmap.height)).toEqual([
      Math.ceil((200 * 320) / 103),
      Math.ceil((200 * 320) / 100),
      Math.ceil((200 * 320) / 102),
    ]);
    expect(recorded.calls.has('fillRect')).toBe(true);
    expect(steps.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('keeps a very tall page from becoming a very tall picture', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const document = await PDFDocument.create();
    document.addPage([100, 2000]);
    const bytes = new Uint8Array(await document.save());
    const { deps } = recorder();
    const output = await renderThumbnails({ file: file(bytes), pages: [0], width: 300 }, deps, {
      progress,
    });
    if (!output.ok) {
      throw new Error(output.issue);
    }
    // 3 times as high as wide at most: 900 pixels, so 45 wide for a page that is 20 times as high.
    expect(output.thumbs[0]?.bitmap.height).toBe(900);
    expect(output.thumbs[0]?.bitmap.width).toBe(45);
  });

  it('skips a page the file does not have and still counts it as done', async () => {
    const { deps } = recorder();
    const steps = vi.fn();
    const output = await renderThumbnails(
      { file: file(await makePdf(2)), pages: [1, 5], width: 320 },
      deps,
      { progress: steps },
    );
    expect(output).toMatchObject({ ok: true });
    expect(output.ok && output.thumbs.map((thumb) => thumb.page)).toEqual([1]);
    expect(steps).toHaveBeenLastCalledWith(2, 2);
  });

  it('returns no thumbnails for no pages', async () => {
    const { deps } = recorder();
    const output = await renderThumbnails(
      { file: file(await makePdf(1)), pages: [], width: 320 },
      deps,
      {
        progress,
      },
    );
    expect(output).toEqual({ ok: true, thumbs: [] });
  });

  it('says "broken" for a file pdf.js cannot open', async () => {
    const { deps } = recorder();
    const output = await renderThumbnails(
      { file: new Blob(['not a pdf']), pages: [0], width: 320 },
      deps,
      { progress },
    );
    expect(output).toEqual({ ok: false, issue: 'broken' });
  });

  it('says "too-large" without reading a file over the limit', async () => {
    const { deps } = recorder();
    const huge = { size: MAX_TOTAL_INPUT_BYTES + 1, arrayBuffer: vi.fn() } as unknown as Blob;
    const output = await renderThumbnails({ file: huge, pages: [0], width: 320 }, deps, {
      progress,
    });
    expect(output).toEqual({ ok: false, issue: 'too-large' });
    expect((huge.arrayBuffer as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('opens a file that is encrypted in a way pdf.js cannot read as broken, not as a crash', async () => {
    const { deps } = recorder();
    const output = await renderThumbnails(
      { file: file(await makeEncryptedPdf()), pages: [0], width: 320 },
      deps,
      { progress },
    );
    expect(output.ok).toBe(false);
  });

  it('gives the drawing surface back to the factory: reset and destroy', async () => {
    const { deps, recorded } = recorder();
    await renderThumbnails({ file: file(await makePdf(1)), pages: [0], width: 320 }, deps, {
      progress,
    });
    // pdf.js made its own surfaces through the factory too and released them.
    expect(recorded.canvases.length).toBeGreaterThanOrEqual(1);
  });
});

describe('thumbTransfer', () => {
  it('lists the bitmaps of a finished job and nothing for a failed one', () => {
    const a = { width: 1, height: 1, close: vi.fn() };
    const b = { width: 1, height: 1, close: vi.fn() };
    const ok: ThumbOutput = {
      ok: true,
      thumbs: [
        { page: 0, bitmap: a },
        { page: 1, bitmap: b },
      ],
    };
    expect(thumbTransfer(ok)).toEqual([a, b]);
    expect(thumbTransfer({ ok: false, issue: 'broken' })).toEqual([]);
  });
});

describe('isThumbInput', () => {
  const good = { file: new Blob(['x']), pages: [0, 1, 2], width: 320 };

  it('accepts a request of the right shape', () => {
    expect(isThumbInput(good)).toBe(true);
    expect(isThumbInput({ ...good, pages: [] })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['no file', { ...good, file: 'x' }],
    ['no width', { ...good, width: undefined }],
    ['an infinite width', { ...good, width: Number.POSITIVE_INFINITY }],
    ['a width of 15', { ...good, width: 15 }],
    ['a width of 2049', { ...good, width: 2049 }],
    ['pages that are not an array', { ...good, pages: 'x' }],
    ['a negative page', { ...good, pages: [-1] }],
    ['a fractional page', { ...good, pages: [0.5] }],
    ['a page that is a string', { ...good, pages: ['0'] }],
  ])('refuses %s', (_name, value) => {
    expect(isThumbInput(value)).toBe(false);
  });

  it('accepts the widths 16 and 2048 and the largest page list', () => {
    expect(isThumbInput({ ...good, width: 16 })).toBe(true);
    expect(isThumbInput({ ...good, width: 2048 })).toBe(true);
    const many = (count: number): number[] => Array.from({ length: count }, (_, index) => index);
    expect(isThumbInput({ ...good, pages: many(MAX_THUMBS_PER_JOB) })).toBe(true);
    expect(isThumbInput({ ...good, pages: many(MAX_THUMBS_PER_JOB + 1) })).toBe(false);
  });
});
