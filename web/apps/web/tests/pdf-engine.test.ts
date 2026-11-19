import { PDFDocument } from 'pdf-lib';
import type * as Limits from '../src/pdf/limits.ts';
import { describe, expect, it, vi } from 'vitest';
import { crc32 } from '../src/pdf/crc32.ts';
import {
  buildPdfs,
  classify,
  inspectPdf,
  normalizeRotation,
  ownBuffer,
} from '../src/pdf/engine.ts';
import { MAX_TOTAL_INPUT_BYTES } from '../src/pdf/limits.ts';
import type { BuildInput, BuildOutput, BuiltFile } from '../src/pdf/types.ts';
import {
  makeEncryptedPdf,
  dumpObjects,
  makePdf,
  rotationsOf,
  unreachableObjects,
  widthsOf,
  withAnnotations,
} from './pdf-fixtures.ts';

const noProgress = (): void => undefined;

function blob(bytes: Uint8Array<ArrayBuffer>): Blob {
  return new Blob([bytes], { type: 'application/pdf' });
}

async function build(
  sources: readonly Blob[],
  outputs: BuildInput['outputs'],
  progress: (completed: number, total: number) => void = noProgress,
): Promise<BuildOutput> {
  return buildPdfs({ kind: 'build', sources, outputs, withChecksums: true }, progress);
}

function filesOf(output: BuildOutput): readonly BuiltFile[] {
  if (!output.ok) {
    throw new Error(`build failed: ${output.issue}`);
  }
  return output.files;
}

const pick = (index: number, turn = 0): { index: number; turn: number } => ({ index, turn });

describe('inspectPdf', () => {
  it('reports the page count and the rotation of every page', async () => {
    const bytes = await makePdf([
      { width: 100 },
      { width: 101, rotation: 90 },
      { width: 102, rotation: 270 },
    ]);
    expect(await inspectPdf(blob(bytes))).toEqual({
      kind: 'inspect',
      ok: true,
      pageCount: 3,
      rotations: [0, 90, 270],
    });
  });

  it('says "encrypted" for a file with an /Encrypt entry', async () => {
    const output = await inspectPdf(blob(await makeEncryptedPdf()));
    expect(output).toEqual({ kind: 'inspect', ok: false, issue: 'encrypted' });
  });

  it.each([
    ['text', new TextEncoder().encode('hello, not a pdf')],
    ['an empty file', new Uint8Array(0)],
    ['a header and nothing else', new TextEncoder().encode('%PDF-1.4\ngarbage')],
  ])('says "broken" for %s', async (_name, bytes) => {
    const output = await inspectPdf(new Blob([new Uint8Array(bytes)]));
    expect(output).toEqual({ kind: 'inspect', ok: false, issue: 'broken' });
  });

  it('says "empty" for a PDF without pages', async () => {
    const document = await PDFDocument.create();
    const bytes = new Uint8Array(await document.save({ addDefaultPage: false }));
    expect(await inspectPdf(blob(bytes))).toEqual({ kind: 'inspect', ok: false, issue: 'empty' });
  });

  it('refuses a file over the size limit without reading it', async () => {
    const huge = { size: MAX_TOTAL_INPUT_BYTES + 1, arrayBuffer: vi.fn() } as unknown as Blob;
    expect(await inspectPdf(huge)).toEqual({ kind: 'inspect', ok: false, issue: 'too-large' });
    expect((huge.arrayBuffer as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('accepts a file exactly at the size limit as far as the limit goes', async () => {
    const atLimit = {
      size: MAX_TOTAL_INPUT_BYTES,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as Blob;
    // The limit passed; the empty bytes are then simply not a PDF.
    expect(await inspectPdf(atLimit)).toEqual({ kind: 'inspect', ok: false, issue: 'broken' });
  });

  it('says "too-large" for a document with more pages than the limit', async () => {
    const bytes = await makePdf(3);
    vi.resetModules();
    vi.doMock('../src/pdf/limits.ts', async (original) => ({
      ...(await original<typeof Limits>()),
      MAX_TOTAL_PAGES: 2,
    }));
    const engine = await import('../src/pdf/engine.ts');
    expect(await engine.inspectPdf(blob(bytes))).toEqual({
      kind: 'inspect',
      ok: false,
      issue: 'too-large',
    });
    vi.doUnmock('../src/pdf/limits.ts');
    vi.resetModules();
  });

  it('says "out-of-memory" when the browser cannot allocate', async () => {
    const failing = {
      size: 10,
      arrayBuffer: () => Promise.reject(new RangeError('Array buffer allocation failed')),
    } as unknown as Blob;
    expect(await inspectPdf(failing)).toEqual({
      kind: 'inspect',
      ok: false,
      issue: 'out-of-memory',
    });
  });
});

describe('classify and normalizeRotation', () => {
  it('tells memory errors from broken files', () => {
    expect(classify(new RangeError('Invalid array length'))).toBe('out-of-memory');
    expect(classify(new RangeError('allocation size overflow'))).toBe('out-of-memory');
    expect(classify(new RangeError('out of memory'))).toBe('out-of-memory');
    expect(classify(new RangeError('Invalid typed array buffer length'))).toBe('out-of-memory');
    expect(classify(new RangeError('Offset is outside the bounds'))).toBe('broken');
    expect(classify(new Error('Array buffer allocation failed'))).toBe('broken');
    expect(classify('x')).toBe('broken');
  });

  it.each([
    [0, 0],
    [90, 90],
    [-90, 270],
    [450, 90],
    [360, 0],
    [45, 90],
    [44, 0],
    [-1, 0],
  ])('reads a rotation of %i as %i', (angle, expected) => {
    expect(normalizeRotation(angle)).toBe(expected);
  });
});

describe('ownBuffer', () => {
  it('keeps a buffer that holds exactly the bytes, and copies a view into a larger one', () => {
    const exact = new Uint8Array([1, 2, 3]);
    expect(ownBuffer(exact).buffer).toBe(exact.buffer);
    const big = new Uint8Array([9, 1, 2, 3, 9]);
    const view = big.subarray(1, 4);
    const copy = ownBuffer(view);
    expect([...copy]).toEqual([1, 2, 3]);
    expect(copy.buffer).not.toBe(big.buffer);
    expect(copy.buffer.byteLength).toBe(3);
    const shifted = new Uint8Array(big.buffer, 1, 4);
    expect(ownBuffer(shifted).byteLength).toBe(4);
    expect(ownBuffer(new Uint8Array(big.buffer, 0, 4)).buffer.byteLength).toBe(4);
  });
});

describe('buildPdfs: failures after the files are read', () => {
  const spec = [{ name: 'x.pdf', parts: [{ source: 0, pages: [{ index: 0, turn: 0 }] }] }];

  it('reports an allocation failure while saving as out-of-memory, and rethrows anything else', async () => {
    const source = new Blob([await makePdf(1)]);
    const save = vi.spyOn(PDFDocument.prototype, 'save');
    save.mockRejectedValueOnce(new RangeError('Invalid array length'));
    expect(await build([source], spec)).toEqual({
      kind: 'build',
      ok: false,
      issue: 'out-of-memory',
    });
    save.mockRejectedValueOnce(new Error('disk on fire'));
    await expect(build([source], spec)).rejects.toThrow('disk on fire');
    save.mockRestore();
    expect((await build([source], spec)).ok).toBe(true);
  });
});

describe('buildPdfs: merge', () => {
  it('puts the pages of the files one after the other', async () => {
    const a = await makePdf(2); // widths 100, 101
    const b = await makePdf([{ width: 200 }, { width: 201 }, { width: 202 }]);
    const progress = vi.fn();
    const output = await build(
      [blob(a), blob(b)],
      [
        {
          name: 'merged.pdf',
          parts: [
            { source: 0, pages: [pick(0), pick(1)] },
            { source: 1, pages: [pick(0), pick(1), pick(2)] },
          ],
        },
      ],
      progress,
    );
    const [file] = filesOf(output);
    expect(file?.name).toBe('merged.pdf');
    expect(file?.pageCount).toBe(5);
    expect(await widthsOf(file?.bytes ?? new Uint8Array())).toEqual([100, 101, 200, 201, 202]);
    // Two parts and one save.
    expect(progress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('uses the same file twice when it is two sources', async () => {
    const a = blob(await makePdf(2));
    const output = await build(
      [a, a],
      [
        {
          name: 'twice.pdf',
          parts: [
            { source: 0, pages: [pick(0), pick(1)] },
            { source: 1, pages: [pick(0), pick(1)] },
          ],
        },
      ],
    );
    expect(await widthsOf(filesOf(output)[0]?.bytes ?? new Uint8Array())).toEqual([
      100, 101, 100, 101,
    ]);
  });

  it('writes a new document without the metadata of the sources', async () => {
    const source = await PDFDocument.create();
    source.addPage([100, 100]);
    source.setTitle('Secret plans');
    source.setAuthor('Somebody');
    const bytes = new Uint8Array(await source.save());
    const output = await build(
      [blob(bytes)],
      [{ name: 'x.pdf', parts: [{ source: 0, pages: [pick(0)] }] }],
    );
    const out = await PDFDocument.load(filesOf(output)[0]?.bytes ?? new Uint8Array(), {
      updateMetadata: false,
    });
    expect(out.getTitle()).toBeUndefined();
    expect(out.getAuthor()).toBeUndefined();
    expect(out.getProducer()).toBeUndefined();
    expect(out.getCreationDate()).toBeUndefined();
  });

  it('names the file that is encrypted', async () => {
    const good = blob(await makePdf(1));
    const locked = blob(await makeEncryptedPdf());
    const output = await build(
      [good, locked],
      [
        {
          name: 'm.pdf',
          parts: [
            { source: 0, pages: [pick(0)] },
            { source: 1, pages: [pick(0)] },
          ],
        },
      ],
    );
    expect(output).toEqual({ kind: 'build', ok: false, issue: 'encrypted', source: 1 });
  });

  it('names the file that is broken', async () => {
    const broken = new Blob([new Uint8Array([1, 2, 3])]);
    const output = await build(
      [broken],
      [{ name: 'm.pdf', parts: [{ source: 0, pages: [pick(0)] }] }],
    );
    expect(output).toEqual({ kind: 'build', ok: false, issue: 'broken', source: 0 });
  });

  it('refuses inputs over the memory guard before reading any of them', async () => {
    const big = { size: MAX_TOTAL_INPUT_BYTES, arrayBuffer: vi.fn() } as unknown as Blob;
    const second = { size: 1, arrayBuffer: vi.fn() } as unknown as Blob;
    const output = await build(
      [big, second],
      [
        {
          name: 'm.pdf',
          parts: [
            { source: 0, pages: [pick(0)] },
            { source: 1, pages: [pick(0)] },
          ],
        },
      ],
    );
    expect(output).toEqual({ kind: 'build', ok: false, issue: 'too-large' });
    expect((big.arrayBuffer as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('only counts the sources an output uses', async () => {
    const big = { size: MAX_TOTAL_INPUT_BYTES + 5, arrayBuffer: vi.fn() } as unknown as Blob;
    const good = blob(await makePdf(1));
    const output = await build(
      [big, good],
      [{ name: 'm.pdf', parts: [{ source: 1, pages: [pick(0)] }] }],
    );
    expect(output.ok).toBe(true);
  });

  it('reports an allocation failure as out-of-memory', async () => {
    const failing = {
      size: 10,
      arrayBuffer: () => Promise.reject(new RangeError('Array buffer allocation failed')),
    } as unknown as Blob;
    const output = await build(
      [failing],
      [{ name: 'm.pdf', parts: [{ source: 0, pages: [pick(0)] }] }],
    );
    expect(output).toEqual({ kind: 'build', ok: false, issue: 'out-of-memory', source: 0 });
  });
});

describe('buildPdfs: split, extract, reorder, rotate', () => {
  it('builds several outputs from one source and loads it once', async () => {
    const source = blob(await makePdf(5)); // widths 100..104
    const spy = vi.spyOn(source, 'arrayBuffer');
    const output = await build(
      [source],
      [
        { name: 'a.pdf', parts: [{ source: 0, pages: [pick(0), pick(1)] }] },
        { name: 'b.pdf', parts: [{ source: 0, pages: [pick(2)] }] },
        { name: 'c.pdf', parts: [{ source: 0, pages: [pick(3), pick(4)] }] },
      ],
    );
    const files = filesOf(output);
    expect(files.map((file) => file.name)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(await Promise.all(files.map((file) => widthsOf(file.bytes)))).toEqual([
      [100, 101],
      [102],
      [103, 104],
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('computes the CRC-32 of every output when asked, else leaves 0', async () => {
    const source = blob(await makePdf(2));
    const spec = [
      { name: 'a.pdf', parts: [{ source: 0, pages: [pick(0)] }] },
      { name: 'b.pdf', parts: [{ source: 0, pages: [pick(1)] }] },
    ];
    const withSums = filesOf(await build([source], spec));
    for (const file of withSums) {
      expect(file.crc32).toBe(crc32(file.bytes));
      expect(file.crc32).not.toBe(0);
    }
    const without = await buildPdfs(
      { kind: 'build', sources: [source], outputs: spec, withChecksums: false },
      noProgress,
    );
    expect(filesOf(without).map((file) => file.crc32)).toEqual([0, 0]);
  });

  it('reorders pages and applies turns on top of the rotation the page has', async () => {
    const source = blob(
      await makePdf([
        { width: 100 },
        { width: 101, rotation: 90 },
        { width: 102, rotation: 270 },
        { width: 103 },
      ]),
    );
    const output = await build(
      [source],
      [
        {
          name: 'e.pdf',
          parts: [{ source: 0, pages: [pick(3, 90), pick(1, 90), pick(2, 180), pick(0, 270)] }],
        },
      ],
    );
    const bytes = filesOf(output)[0]?.bytes ?? new Uint8Array();
    expect(await widthsOf(bytes)).toEqual([103, 101, 102, 100]);
    expect(await rotationsOf(bytes)).toEqual([90, 180, 90, 270]);
  });

  it('keeps a rotation the page inherits from the page tree', async () => {
    const { PDFName, PDFNumber } = await import('pdf-lib');
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    document.addPage([100, 100]);
    // Rotation and size on the parent node only.
    const catalog = document.catalog;
    const pages = catalog.Pages();
    pages.set(PDFName.of('Rotate'), PDFNumber.of(90));
    const bytes = new Uint8Array(await document.save({ useObjectStreams: false }));
    expect(await inspectPdf(blob(bytes))).toMatchObject({ ok: true, rotations: [90, 90] });
    const output = await build(
      [blob(bytes)],
      [{ name: 'i.pdf', parts: [{ source: 0, pages: [pick(1, 90)] }] }],
    );
    expect(await rotationsOf(filesOf(output)[0]?.bytes ?? new Uint8Array())).toEqual([180]);
  });

  it('can use a page twice', async () => {
    const source = blob(await makePdf(2));
    const output = await build(
      [source],
      [{ name: 'd.pdf', parts: [{ source: 0, pages: [pick(1), pick(1, 90), pick(0)] }] }],
    );
    const bytes = filesOf(output)[0]?.bytes ?? new Uint8Array();
    expect(await widthsOf(bytes)).toEqual([101, 101, 100]);
    expect(await rotationsOf(bytes)).toEqual([0, 90, 0]);
  });

  it.each([
    ['a page past the end', pick(5)],
    ['a negative page', pick(-1)],
    ['a fractional page', pick(0.5)],
    ['a turn of 45 degrees', pick(0, 45)],
    ['a negative turn', pick(0, -90)],
    ['a turn past 270', pick(0, 360)],
    ['a fractional turn', pick(0, 90.5)],
  ])('refuses %s as a bad request', async (_name, bad) => {
    const source = blob(await makePdf(2));
    await expect(
      build([source], [{ name: 'x.pdf', parts: [{ source: 0, pages: [bad] }] }]),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it.each([-1, 1, 0.5])('refuses the source number %s as a bad request', async (bad) => {
    const source = blob(await makePdf(1));
    await expect(
      build([source], [{ name: 'x.pdf', parts: [{ source: bad, pages: [pick(0)] }] }]),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('buildPdfs: deleted pages leave nothing behind', () => {
  it('copies web links and markup', async () => {
    let bytes = await makePdf(2);
    bytes = await withAnnotations(bytes, 0, 1, 'uri');
    const output = await build(
      [blob(bytes)],
      [{ name: 'u.pdf', parts: [{ source: 0, pages: [pick(0)] }] }],
    );
    const { PDFName, PDFArray } = await import('pdf-lib');
    const out = await PDFDocument.load(filesOf(output)[0]?.bytes ?? new Uint8Array());
    const annots = out.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBe(1);
    expect(await unreachableObjects(filesOf(output)[0]?.bytes ?? new Uint8Array())).toBe(0);
  });

  it('keeps a highlight but cuts its popup and page reference', async () => {
    let bytes = await makePdf(2);
    bytes = await withAnnotations(bytes, 0, 1, 'highlight');
    const output = await build(
      [blob(bytes)],
      [{ name: 'h.pdf', parts: [{ source: 0, pages: [pick(0)] }] }],
    );
    const out = filesOf(output)[0]?.bytes ?? new Uint8Array();
    const text = await dumpObjects(out);
    expect(text).toContain('/Highlight');
    expect(text).not.toContain('/Popup');
    expect(await unreachableObjects(out)).toBe(0);
  });

  it.each(['dest', 'field'] as const)(
    'drops a %s annotation so the page it points at is not dragged along',
    async (kind) => {
      const source = await withAnnotations(await makePdf(2, { text: 'marker' }), 0, 1, kind);
      const output = await build(
        [blob(source)],
        [{ name: 'only-first.pdf', parts: [{ source: 0, pages: [pick(0)] }] }],
      );
      const out = filesOf(output)[0]?.bytes ?? new Uint8Array();
      expect(await widthsOf(out)).toEqual([100]);
      // No second page object, no unreachable objects (a dragged-along page is one).
      expect(await unreachableObjects(out)).toBe(0);
      const text = await dumpObjects(out);
      expect(text.match(/\/Type \/Page\b(?!s)/g)).toHaveLength(1);
      expect(text).not.toContain('/Widget');
      expect(text).not.toContain('/Dest');
    },
  );

  it('proves the leak the guard prevents: without it the other page comes along', async () => {
    const source = await withAnnotations(await makePdf(2), 0, 1, 'dest');
    const document = await PDFDocument.load(source);
    const naive = await PDFDocument.create();
    const [copy] = await naive.copyPages(document, [0]);
    if (copy === undefined) {
      throw new Error('no copy');
    }
    naive.addPage(copy);
    const naiveBytes = await naive.save({ useObjectStreams: false });
    expect(await unreachableObjects(naiveBytes)).toBeGreaterThan(0);
  });

  it('drops internal links, actions and other annotation types', async () => {
    const { PDFName } = await import('pdf-lib');
    const document = await PDFDocument.load(await makePdf(2));
    const { context } = document;
    const page = document.getPage(0);
    const annotations = [
      {
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [0, 0, 1, 1],
        A: { S: 'GoTo', D: [document.getPage(1).ref, 'Fit'] },
      },
      { Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 1, 1], A: 5 },
      { Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 1, 1] },
      { Type: 'Annot', Subtype: 'FileAttachment', Rect: [0, 0, 1, 1] },
      { Type: 'Annot', Rect: [0, 0, 1, 1] },
    ].map((entry) => context.register(context.obj(entry)));
    page.node.set(PDFName.of('Annots'), context.obj(annotations));
    page.node.set(PDFName.of('AA'), context.obj({ O: { S: 'JavaScript', JS: 'x' } }));
    page.node.set(PDFName.of('B'), context.obj([document.getPage(1).ref]));
    const bytes = new Uint8Array(await document.save({ useObjectStreams: false }));
    const output = await build(
      [blob(bytes)],
      [{ name: 'a.pdf', parts: [{ source: 0, pages: [pick(0)] }] }],
    );
    const out = filesOf(output)[0]?.bytes ?? new Uint8Array();
    const text = await dumpObjects(out);
    // Only the link without an action survives; the rest is gone, and so is the second page.
    expect(text.match(/\/Subtype \/Link/g)).toHaveLength(1);
    expect(text).not.toMatch(/GoTo|FileAttachment|JavaScript|\/AA|\/B /);
    expect(await unreachableObjects(out)).toBe(0);
  });

  it('removes the Next action chain of a web link', async () => {
    const { PDFName, PDFString } = await import('pdf-lib');
    const document = await PDFDocument.load(await makePdf(2));
    const { context } = document;
    const page = document.getPage(0);
    const link = context.register(
      context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [0, 0, 1, 1],
        A: {
          S: 'URI',
          URI: PDFString.of('https://example.org/'),
          Next: { S: 'GoTo', D: [document.getPage(1).ref, 'Fit'] },
        },
      }),
    );
    page.node.set(PDFName.of('Annots'), context.obj([link]));
    const bytes = new Uint8Array(await document.save({ useObjectStreams: false }));
    const output = await build(
      [blob(bytes)],
      [{ name: 'a.pdf', parts: [{ source: 0, pages: [pick(0)] }] }],
    );
    const out = filesOf(output)[0]?.bytes ?? new Uint8Array();
    expect(await dumpObjects(out)).not.toContain('GoTo');
    expect(await unreachableObjects(out)).toBe(0);
  });

  it('never carries a deleted page into the output, for any selection of pages', async () => {
    // Property: for every subset of pages (all 2^5), with a field linking all pages, the output
    // has exactly those pages and no object that no page reaches.
    let bytes = await makePdf(5);
    bytes = await withAnnotations(bytes, 0, 4, 'dest');
    bytes = await withAnnotations(bytes, 2, 3, 'field');
    const source = blob(bytes);
    for (let mask = 1; mask < 32; mask += 1) {
      const pages = [0, 1, 2, 3, 4].filter((index) => (mask & (1 << index)) !== 0);
      const output = await build(
        [source],
        [{ name: 's.pdf', parts: [{ source: 0, pages: pages.map((index) => pick(index)) }] }],
      );
      const out = filesOf(output)[0]?.bytes ?? new Uint8Array();
      expect(await widthsOf(out)).toEqual(pages.map((index) => 100 + index));
      expect(await unreachableObjects(out), `pages ${pages.join(',')}`).toBe(0);
    }
  });
});
