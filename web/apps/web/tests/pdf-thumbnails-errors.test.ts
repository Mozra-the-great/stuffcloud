import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasLike } from '../src/pdf/thumbnails.ts';

/** pdf.js failures that are hard to produce with a real file: the answers are scripted. */

const getDocument = vi.fn<(options: unknown) => unknown>();
const createWorker = vi.fn<(options: unknown) => unknown>(() => ({ kind: 'pdf.js worker' }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  PDFWorker: { create: (options: unknown) => createWorker(options) },
  getDocument: (options: unknown) => getDocument(options),
}));

const { renderThumbnails } = await import('../src/pdf/thumbnails.ts');

function canvas(width = 1, height = 1): CanvasLike {
  const self: CanvasLike = {
    width,
    height,
    getContext: () => ({}),
    transferToImageBitmap: () => ({ width: self.width, height: self.height, close: vi.fn() }),
  };
  return self;
}

const deps = { createCanvas: canvas };
const input = { file: new Blob(['x']), pages: [0], width: 100 };
const progress = (): void => undefined;

beforeEach(() => {
  getDocument.mockReset();
  createWorker.mockClear();
});

function failing(error: unknown): void {
  const destroy = vi.fn(() => Promise.resolve());
  getDocument.mockReturnValue({
    promise: Promise.reject(error instanceof Error ? error : new Error(String(error))),
    destroy,
  });
}

describe('renderThumbnails: why a file cannot be drawn', () => {
  it('says "encrypted" for a password exception', async () => {
    failing(Object.assign(new Error('No password given'), { name: 'PasswordException' }));
    expect(await renderThumbnails(input, deps, { progress })).toEqual({
      ok: false,
      issue: 'encrypted',
    });
  });

  it('says "out-of-memory" for an allocation failure', async () => {
    failing(new RangeError('Array buffer allocation failed'));
    expect(await renderThumbnails(input, deps, { progress })).toEqual({
      ok: false,
      issue: 'out-of-memory',
    });
  });

  it.each([
    [
      'an invalid PDF',
      Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' }),
    ],
    ['a plain error', new Error('x')],
    ['a range error that is no memory problem', new RangeError('offset out of bounds')],
    ['something that is no error', 'text'],
  ])('says "broken" for %s', async (_name, error) => {
    failing(error);
    expect(await renderThumbnails(input, deps, { progress })).toEqual({
      ok: false,
      issue: 'broken',
    });
  });

  it('releases the document whatever happens', async () => {
    const destroy = vi.fn(() => Promise.resolve());
    getDocument.mockReturnValue({ promise: Promise.reject(new Error('x')), destroy });
    await renderThumbnails(input, deps, { progress });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('leaves out a page that fails and keeps the others', async () => {
    const destroy = vi.fn(() => Promise.resolve());
    const cleanup = vi.fn();
    const document = {
      numPages: 3,
      getPage: vi.fn((number: number) =>
        number === 2
          ? Promise.reject(new Error('bad page'))
          : Promise.resolve({
              getViewport: ({ scale }: { scale: number }) => ({
                width: 100 * scale,
                height: 200 * scale,
              }),
              render: () => ({ promise: Promise.resolve() }),
              cleanup,
            }),
      ),
    };
    getDocument.mockReturnValue({ promise: Promise.resolve(document), destroy });
    const steps = vi.fn();
    const output = await renderThumbnails({ ...input, pages: [0, 1, 2] }, deps, {
      progress: steps,
    });
    expect(output.ok && output.thumbs.map((thumb) => thumb.page)).toEqual([0, 2]);
    expect(steps).toHaveBeenCalledTimes(3);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('asks pdf.js for nothing that needs a network or a page', async () => {
    failing(new Error('stop here'));
    await renderThumbnails(input, deps, { progress });
    const options = getDocument.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options['disableFontFace']).toBe(true);
    expect(options['useWasm']).toBe(false);
    expect(options['disableWorkerRendering']).toBe(true);
    for (const key of [
      'url',
      'cMapUrl',
      'standardFontDataUrl',
      'wasmUrl',
      'iccUrl',
      'httpHeaders',
    ]) {
      expect(options[key]).toBeUndefined();
    }
  });

  it('gives pdf.js a canvas factory on the worker canvas and a filter factory that filters nothing', async () => {
    failing(new Error('stop here'));
    await renderThumbnails(input, deps, { progress });
    const options = getDocument.mock.calls[0]?.[0] as {
      CanvasFactory: new () => {
        create(w: number, h: number): { canvas: CanvasLike | null; context: unknown };
        reset(surface: { canvas: CanvasLike | null }, w: number, h: number): void;
        destroy(surface: { canvas: CanvasLike | null; context: unknown }): void;
        getNoAlphaContext(canvas: CanvasLike): unknown;
      };
      FilterFactory: new () => Record<string, () => unknown>;
    };
    const factory = new options.CanvasFactory();
    const surface = factory.create(10, 20);
    expect(surface.canvas).toMatchObject({ width: 10, height: 20 });
    expect(surface.context).toEqual({});
    factory.reset(surface, 30, 40);
    expect(surface.canvas).toMatchObject({ width: 30, height: 40 });
    expect(factory.getNoAlphaContext(canvas())).toEqual({});
    const held = surface.canvas;
    factory.destroy(surface);
    expect(held).toMatchObject({ width: 0, height: 0 });
    expect(surface).toEqual({ canvas: null, context: null });
    // Destroying or resetting a surface that is already gone does nothing.
    factory.destroy(surface);
    factory.reset(surface, 1, 1);

    const filters = new options.FilterFactory();
    for (const method of [
      'addFilter',
      'addHCMFilter',
      'addAlphaFilter',
      'addLuminosityFilter',
      'addKnockoutFilter',
      'addHighlightHCMFilter',
      'addSelectionHCMFilter',
      'addSelectionFilter',
    ]) {
      expect(filters[method]?.()).toBe('none');
    }
    expect(filters['createSelectionStyle']?.()).toBeNull();
    expect(filters['destroy']?.()).toBeUndefined();
  });

  it('parses in the worker the thumbnail worker provides, and stops it afterwards', async () => {
    failing(new Error('stop here'));
    const terminate = vi.fn();
    const parser = { terminate };
    await renderThumbnails(input, { ...deps, createParserWorker: () => parser }, { progress });
    expect(createWorker).toHaveBeenCalledWith({ port: parser, verbosity: 0 });
    const options = getDocument.mock.calls[0]?.[0] as { worker: unknown };
    expect(options.worker).toEqual({ kind: 'pdf.js worker' });
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('starts no worker of its own when none is provided', async () => {
    failing(new Error('stop here'));
    await renderThumbnails(input, deps, { progress });
    expect(createWorker).not.toHaveBeenCalled();
    expect(getDocument.mock.calls[0]?.[0]).not.toHaveProperty('worker');
  });
});
