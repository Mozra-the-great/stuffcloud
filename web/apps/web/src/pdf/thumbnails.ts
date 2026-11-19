import { getDocument, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TaskContext } from '@stuffcloud/tools';
import { fitsInputLimit } from './limits.ts';
import type { PdfIssue, Thumb, ThumbBitmap, ThumbInput, ThumbOutput } from './types.ts';

/**
 * Page pictures with pdf.js (Apache-2.0), drawn on an `OffscreenCanvas` in a worker. pdf.js is
 * given everything it would otherwise fetch or look up in the page: the canvas and its own parser
 * worker come from `deps` (the parser is a file of the app, started from `thumbs-worker.ts`),
 * nothing is requested from any other URL (ADR 0013). The pictures are bitmaps, moved to the page
 * without a copy.
 */

/** The drawing surface the worker provides; an `OffscreenCanvas` fits. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(contextId: '2d'): unknown;
  transferToImageBitmap(): ThumbBitmap;
}

/** A worker running pdf.js's parser (`pdf.worker`), started by the thumbnail worker. */
export interface ParserWorker {
  terminate(): void;
}

export interface ThumbnailDeps {
  createCanvas(width: number, height: number): CanvasLike;
  /**
   * Starts the worker pdf.js parses in. Without it pdf.js parses in the calling thread, which
   * needs `globalThis.pdfjsWorker` (the tests do that); a worker must not load pdf.js's worker
   * code into its own scope, because that code takes the scope over as its message port.
   */
  createParserWorker?: () => ParserWorker;
}

/** The tallest picture is this many times as high as it is wide (a page 1 m long stays a picture). */
const MAX_ASPECT = 3;

const WHITE = 'rgb(255,255,255)';

interface Surface {
  canvas: CanvasLike | null;
  context: unknown;
}

type CanvasFactoryClass = new () => {
  create(width: number, height: number): Surface;
  reset(surface: Surface, width: number, height: number): void;
  destroy(surface: Surface): void;
  getNoAlphaContext(canvas: CanvasLike): unknown;
};

/** The pdf.js canvas factory, backed by `deps` instead of `document.createElement`. */
function canvasFactoryFor(deps: ThumbnailDeps): CanvasFactoryClass {
  return class CanvasFactory {
    create(width: number, height: number): Surface {
      const canvas = deps.createCanvas(width, height);
      return { canvas, context: canvas.getContext('2d') };
    }

    reset(surface: Surface, width: number, height: number): void {
      if (surface.canvas !== null) {
        surface.canvas.width = width;
        surface.canvas.height = height;
      }
    }

    destroy(surface: Surface): void {
      if (surface.canvas !== null) {
        surface.canvas.width = 0;
        surface.canvas.height = 0;
      }
      surface.canvas = null;
      surface.context = null;
    }

    getNoAlphaContext(canvas: CanvasLike): unknown {
      return canvas.getContext('2d');
    }
  };
}

/** pdf.js asks its filter factory for SVG filters (high-contrast mode); a worker has none. */
class NoFilters {
  addFilter(): string {
    return 'none';
  }
  addHCMFilter(): string {
    return 'none';
  }
  addAlphaFilter(): string {
    return 'none';
  }
  addLuminosityFilter(): string {
    return 'none';
  }
  addKnockoutFilter(): string {
    return 'none';
  }
  addHighlightHCMFilter(): string {
    return 'none';
  }
  addSelectionHCMFilter(): string {
    return 'none';
  }
  addSelectionFilter(): string {
    return 'none';
  }
  createSelectionStyle(): null {
    return null;
  }
  destroy(): void {
    // Nothing was created.
  }
}

function issueOf(error: unknown): PdfIssue {
  if (error instanceof Error && error.name === 'PasswordException') {
    return 'encrypted';
  }
  if (
    error instanceof RangeError &&
    /alloc|memory|array length|buffer length/i.test(error.message)
  ) {
    return 'out-of-memory';
  }
  return 'broken';
}

/**
 * Draws the pages `input.pages` of the PDF. A page that cannot be drawn is left out (the page shows
 * a placeholder), the others still come; a file that cannot be opened is the whole job's issue.
 */
export async function renderThumbnails(
  input: ThumbInput,
  deps: ThumbnailDeps,
  { progress }: Pick<TaskContext, 'progress'>,
): Promise<ThumbOutput> {
  if (!fitsInputLimit(input.file.size)) {
    return { ok: false, issue: 'too-large' };
  }
  const data = new Uint8Array(await input.file.arrayBuffer());
  const parser = deps.createParserWorker?.();
  const task = getDocument({
    data,
    ...(parser === undefined
      ? {}
      : { worker: PDFWorker.create({ port: parser as unknown as Worker, verbosity: 0 }) }),
    CanvasFactory: canvasFactoryFor(deps),
    FilterFactory: NoFilters,
    // Glyphs are drawn as paths: there is no page to register fonts with in a worker.
    disableFontFace: true,
    useSystemFonts: false,
    useWasm: false,
    disableWorkerRendering: true,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    const thumbs: Thumb[] = [];
    let done = 0;
    for (const index of input.pages) {
      if (index < document.numPages) {
        try {
          const page = await document.getPage(index + 1);
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(
            input.width / base.width,
            (input.width * MAX_ASPECT) / base.height,
          );
          const viewport = page.getViewport({ scale });
          const canvas = deps.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({
            canvasContext: canvas.getContext('2d') as CanvasRenderingContext2D,
            canvas: canvas as unknown as HTMLCanvasElement,
            viewport,
            background: WHITE,
          }).promise;
          thumbs.push({ page: index, bitmap: canvas.transferToImageBitmap() });
          page.cleanup();
        } catch {
          // This page stays without a picture.
        }
      }
      done += 1;
      progress(done, input.pages.length);
    }
    return { ok: true, thumbs };
  } catch (error: unknown) {
    return { ok: false, issue: issueOf(error) };
  } finally {
    await task.destroy();
    parser?.terminate();
  }
}

/** The pictures of a finished job, moved to the page. */
export function thumbTransfer(output: ThumbOutput): object[] {
  return output.ok ? output.thumbs.map((thumb) => thumb.bitmap) : [];
}
