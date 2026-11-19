import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { batches, batchSize, THUMB_WIDTH, ThumbnailStore } from '../src/pdf/thumbs.svelte.ts';
import type { PdfRunner, ThumbInput, ThumbOutput } from '../src/pdf/types.ts';
import { makeEncryptedPdf, makePdf, pdfFile } from './pdf-fixtures.ts';
import { fakeBitmap, fakeThumbs, inProcessOps } from './pdf-helpers.ts';

const runners = vi.hoisted(
  (): {
    ops: unknown;
    thumbs: unknown;
    createOps: Mock<() => void>;
    createThumbs: Mock<() => void>;
  } => ({
    ops: undefined,
    thumbs: undefined,
    createOps: vi.fn<() => void>(),
    createThumbs: vi.fn<() => void>(),
  }),
);

vi.mock('../src/pdf/runners.ts', () => ({
  createOpsRunner: () => {
    runners.createOps();
    return runners.ops;
  },
  createThumbRunner: () => {
    runners.createThumbs();
    return runners.thumbs;
  },
}));

const { SingleDocument } = await import('../src/pdf/session.svelte.ts');

describe('batches', () => {
  it.each([
    [1, 8],
    [80, 8],
    [81, 9],
    [400, 40],
    [500, 40],
    [10_000, 40],
  ])('uses %i pages as jobs of %i', (pages, size) => {
    expect(batchSize(pages)).toBe(size);
  });

  it('covers every page once, in order', () => {
    for (const count of [1, 7, 8, 9, 100, 501]) {
      const all = batches(count);
      expect(all.flat()).toEqual(Array.from({ length: count }, (_, index) => index));
      expect(all.slice(0, -1).every((job) => job.length === batchSize(count))).toBe(true);
    }
    expect(batches(0)).toEqual([]);
  });
});

describe('ThumbnailStore', () => {
  it('asks for the pages in jobs and keeps the pictures by page', async () => {
    const runner = fakeThumbs();
    const file = new Blob(['x']);
    const store = new ThumbnailStore(runner, file, 20);
    expect(store.bitmap(0)).toBeUndefined();
    store.start();
    await vi.waitFor(() => {
      expect(store.bitmap(19)).toBeDefined();
    });
    expect(runner.calls.map((call) => call.pages.length)).toEqual([8, 8, 4]);
    expect(runner.calls.every((call) => call.file === file && call.width === THUMB_WIDTH)).toBe(
      true,
    );
    for (let page = 0; page < 20; page += 1) {
      expect(store.bitmap(page)).toBeDefined();
    }
    expect(store.failed).toBe(false);
  });

  it('closes a picture that is replaced', async () => {
    const first = fakeBitmap();
    const second = fakeBitmap();
    const answers: ThumbOutput[] = [
      { ok: true, thumbs: [{ page: 0, bitmap: first }] },
      { ok: true, thumbs: [{ page: 0, bitmap: second }] },
    ];
    const runner: PdfRunner<ThumbInput, ThumbOutput> = {
      run: () => Promise.resolve(answers.shift() ?? { ok: true, thumbs: [] }),
      terminate: vi.fn(),
    };
    const store = new ThumbnailStore(runner, new Blob(['x']), 9);
    store.start();
    await vi.waitFor(() => {
      expect(store.bitmap(0)).toBe(second);
    });
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
  });

  it('leaves a placeholder for a page that came back without a picture', async () => {
    const runner: PdfRunner<ThumbInput, ThumbOutput> = {
      run: () => Promise.resolve({ ok: true, thumbs: [{ page: 1, bitmap: fakeBitmap() }] }),
      terminate: vi.fn(),
    };
    const store = new ThumbnailStore(runner, new Blob(['x']), 3);
    store.start();
    await vi.waitFor(() => {
      expect(store.bitmap(1)).toBeDefined();
    });
    expect(store.bitmap(0)).toBeUndefined();
    expect(store.bitmap(2)).toBeUndefined();
  });

  it('notes a job that failed, and one that threw', async () => {
    const refusing: PdfRunner<ThumbInput, ThumbOutput> = {
      run: () => Promise.resolve({ ok: false, issue: 'broken' }),
      terminate: vi.fn(),
    };
    const a = new ThumbnailStore(refusing, new Blob(['x']), 3);
    a.start();
    await vi.waitFor(() => {
      expect(a.failed).toBe(true);
    });
    const crashing: PdfRunner<ThumbInput, ThumbOutput> = {
      run: () => Promise.reject(new Error('worker died')),
      terminate: vi.fn(),
    };
    const b = new ThumbnailStore(crashing, new Blob(['x']), 3);
    b.start();
    await vi.waitFor(() => {
      expect(b.failed).toBe(true);
    });
  });

  it('frees the pictures and cancels the jobs on dispose, and drops what arrives later', async () => {
    const late = fakeBitmap();
    let finish: (output: ThumbOutput) => void = () => undefined;
    const signals: AbortSignal[] = [];
    const runner: PdfRunner<ThumbInput, ThumbOutput> = {
      run: (_input, options) => {
        if (options?.signal !== undefined) {
          signals.push(options.signal);
        }
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      terminate: vi.fn(),
    };
    const ready = fakeThumbs();
    const early = new ThumbnailStore(ready, new Blob(['x']), 3);
    early.start();
    await vi.waitFor(() => {
      expect(early.bitmap(2)).toBeDefined();
    });
    const held = ready.bitmaps.slice();
    early.dispose();
    expect(held.every((bitmap) => bitmap.close.mock.calls.length === 1)).toBe(true);
    expect(early.bitmap(0)).toBeUndefined();

    const store = new ThumbnailStore(runner, new Blob(['x']), 3);
    store.start();
    store.dispose();
    expect(signals[0]?.aborted).toBe(true);
    finish({ ok: true, thumbs: [{ page: 0, bitmap: late }] });
    await vi.waitFor(() => {
      expect(late.close).toHaveBeenCalledTimes(1);
    });
    expect(store.bitmap(0)).toBeUndefined();
  });

  it('does not call a cancelled job a failure', async () => {
    const runner: PdfRunner<ThumbInput, ThumbOutput> = {
      run: () => Promise.reject(new DOMException('aborted', 'AbortError')),
      terminate: vi.fn(),
    };
    const store = new ThumbnailStore(runner, new Blob(['x']), 3);
    store.start();
    store.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.failed).toBe(false);
  });
});

describe('SingleDocument', () => {
  beforeEach(() => {
    runners.ops = inProcessOps();
    runners.thumbs = fakeThumbs();
    runners.createOps.mockClear();
    runners.createThumbs.mockClear();
  });

  it('starts empty and starts no worker before it is used', () => {
    const doc = new SingleDocument();
    expect(doc.state).toBe('empty');
    expect(doc.file).toBeUndefined();
    expect(doc.pageCount).toBe(0);
    expect(runners.createOps).not.toHaveBeenCalled();
  });

  it('opens a PDF and keeps its page count and rotations', async () => {
    const doc = new SingleDocument();
    const file = pdfFile(await makePdf([{ width: 100 }, { width: 101, rotation: 90 }]));
    const promise = doc.open(file);
    expect(doc.state).toBe('reading');
    expect(doc.file).toBe(file);
    expect(await promise).toBe(true);
    expect(doc.state).toBe('ready');
    expect(doc.pageCount).toBe(2);
    expect(doc.rotations).toEqual([0, 90]);
    expect(doc.issue).toBeUndefined();
    // The pool is made once.
    await doc.open(file);
    expect(runners.createOps).toHaveBeenCalledTimes(1);
  });

  it('keeps the reason a file cannot be used', async () => {
    const doc = new SingleDocument();
    expect(await doc.open(pdfFile(await makeEncryptedPdf()))).toBe(false);
    expect(doc.state).toBe('empty');
    expect(doc.issue).toBe('encrypted');
    expect(doc.crashed).toBe(false);
    expect(await doc.open(pdfFile(await makePdf(1)))).toBe(true);
    expect(doc.issue).toBeUndefined();
  });

  it('notes a worker that failed', async () => {
    runners.ops = {
      run: () => Promise.reject(new Error('worker crashed')),
      terminate: vi.fn(),
    };
    const doc = new SingleDocument();
    expect(await doc.open(pdfFile(await makePdf(1)))).toBe(false);
    expect(doc.crashed).toBe(true);
    expect(doc.state).toBe('empty');
  });

  it('lets the newer file win when a second one is opened while the first is read', async () => {
    const doc = new SingleDocument();
    const first = doc.open(pdfFile(await makePdf(3), 'first.pdf'));
    const second = doc.open(pdfFile(await makePdf(5), 'second.pdf'));
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(doc.pageCount).toBe(5);
    expect(doc.file?.name).toBe('second.pdf');
    expect(doc.crashed).toBe(false);
  });

  it('does not take the rejection of a cancelled open for a failure', async () => {
    runners.ops = {
      run: (_input: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
      terminate: vi.fn(),
    };
    const doc = new SingleDocument();
    const first = doc.open(pdfFile(await makePdf(1), 'first.pdf'));
    doc.close();
    expect(await first).toBe(false);
    expect(doc.crashed).toBe(false);
    expect(doc.state).toBe('empty');
  });

  it('draws the pictures once per file, only for a file that is open', async () => {
    const doc = new SingleDocument();
    doc.startThumbs();
    expect(doc.thumbs).toBeUndefined();
    await doc.open(pdfFile(await makePdf(3)));
    doc.startThumbs();
    const store = doc.thumbs;
    expect(store).toBeDefined();
    doc.startThumbs();
    expect(doc.thumbs).toBe(store);
    expect(runners.createThumbs).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(store?.bitmap(2)).toBeDefined();
    });
    // A new file gets new pictures; the old ones are freed.
    await doc.open(pdfFile(await makePdf(2)));
    expect(doc.thumbs).toBeUndefined();
    doc.startThumbs();
    expect(doc.thumbs).not.toBe(store);
    expect(runners.createThumbs).toHaveBeenCalledTimes(1);
  });

  it('forgets the file on close and stops the workers on dispose', async () => {
    const doc = new SingleDocument();
    await doc.open(pdfFile(await makePdf(2)));
    doc.startThumbs();
    doc.close();
    expect(doc.state).toBe('empty');
    expect(doc.file).toBeUndefined();
    expect(doc.pageCount).toBe(0);
    expect(doc.rotations).toEqual([]);
    expect(doc.thumbs).toBeUndefined();
    doc.dispose();
    expect(
      (runners.ops as { terminate: ReturnType<typeof vi.fn> }).terminate,
    ).toHaveBeenCalledTimes(1);
    expect(
      (runners.thumbs as { terminate: ReturnType<typeof vi.fn> }).terminate,
    ).toHaveBeenCalledTimes(1);
    // Disposing again, or before any worker started, is harmless.
    doc.dispose();
    new SingleDocument().dispose();
  });

  it('gives the pool a fresh start after dispose', async () => {
    const doc = new SingleDocument();
    await doc.open(pdfFile(await makePdf(1)));
    doc.dispose();
    await doc.open(pdfFile(await makePdf(1)));
    expect(runners.createOps).toHaveBeenCalledTimes(2);
  });
});
