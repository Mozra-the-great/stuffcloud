import type * as Tools from '@stuffcloud/tools';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { buildFiles, inspectFile } from '../src/pdf/client.ts';
import { isPdfInput, runPdfTask, transferOf } from '../src/pdf/task.ts';
import type {
  BuildOutput,
  InspectOutput,
  PdfInput,
  PdfOutput,
  PdfRunner,
} from '../src/pdf/types.ts';
import { makePdf } from './pdf-fixtures.ts';
import { inProcessOps } from './pdf-helpers.ts';

const blob = new Blob(['x']);

describe('isPdfInput', () => {
  const part = { source: 0, pages: [{ index: 0, turn: 0 }] };
  const build = {
    kind: 'build',
    withChecksums: false,
    sources: [blob],
    outputs: [{ name: 'a.pdf', parts: [part] }],
  };

  it('accepts the two kinds of job', () => {
    expect(isPdfInput({ kind: 'inspect', file: blob })).toBe(true);
    expect(isPdfInput(build)).toBe(true);
    expect(isPdfInput({ ...build, sources: [], outputs: [] })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'inspect'],
    ['an unknown kind', { kind: 'other', file: blob }],
    ['an inspect without a file', { kind: 'inspect' }],
    ['an inspect with a string for a file', { kind: 'inspect', file: 'x' }],
    ['a build without the checksum flag', { ...build, withChecksums: undefined }],
    ['a build with sources that are no blobs', { ...build, sources: ['x'] }],
    ['a build with sources that are no array', { ...build, sources: blob }],
    ['a build with outputs that are no array', { ...build, outputs: {} }],
    ['an output without a name', { ...build, outputs: [{ parts: [part] }] }],
    ['an output without parts', { ...build, outputs: [{ name: 'a.pdf' }] }],
    ['an output that is null', { ...build, outputs: [null] }],
    ['a part without a source', { ...build, outputs: [{ name: 'a', parts: [{ pages: [] }] }] }],
    ['a part without pages', { ...build, outputs: [{ name: 'a', parts: [{ source: 0 }] }] }],
    [
      'a page without a turn',
      { ...build, outputs: [{ name: 'a', parts: [{ source: 0, pages: [{ index: 0 }] }] }] },
    ],
    [
      'a page without an index',
      { ...build, outputs: [{ name: 'a', parts: [{ source: 0, pages: [{ turn: 0 }] }] }] },
    ],
    [
      'a page that is a number',
      { ...build, outputs: [{ name: 'a', parts: [{ source: 0, pages: [3] }] }] },
    ],
  ])('refuses %s', (_name, value) => {
    expect(isPdfInput(value)).toBe(false);
  });
});

describe('runPdfTask and transferOf', () => {
  it('inspects a file and reports one step of one', async () => {
    const progress = vi.fn();
    const file = new Blob([await makePdf(2)]);
    const output = await runPdfTask({ kind: 'inspect', file }, { progress });
    expect(output).toMatchObject({ kind: 'inspect', ok: true, pageCount: 2 });
    expect(progress).toHaveBeenCalledWith(1, 1);
  });

  it('builds and hands the buffers over', async () => {
    const progress = vi.fn();
    const file = new Blob([await makePdf(2)]);
    const output = await runPdfTask(
      {
        kind: 'build',
        withChecksums: false,
        sources: [file],
        outputs: [{ name: 'a.pdf', parts: [{ source: 0, pages: [{ index: 1, turn: 0 }] }] }],
      },
      { progress },
    );
    expect(progress).toHaveBeenCalledWith(2, 2);
    if (output.kind !== 'build' || !output.ok) {
      throw new Error('build failed');
    }
    expect(transferOf(output)).toEqual([output.files[0]?.bytes.buffer]);
  });

  it('transfers nothing for answers without files', () => {
    expect(transferOf({ kind: 'inspect', ok: false, issue: 'broken' })).toEqual([]);
    expect(transferOf({ kind: 'build', ok: false, issue: 'broken' })).toEqual([]);
    expect(transferOf({ kind: 'inspect', ok: true, pageCount: 1, rotations: [0] })).toEqual([]);
  });
});

describe('inspectFile and buildFiles', () => {
  const inspectOk: InspectOutput = {
    kind: 'inspect',
    ok: true,
    pageCount: 3,
    rotations: [0, 0, 0],
  };
  const buildOk: BuildOutput = { kind: 'build', ok: true, files: [] };

  type Run = PdfRunner<PdfInput, PdfOutput>['run'];

  function runner(answer: PdfOutput): PdfRunner<PdfInput, PdfOutput> & { run: Mock<Run> } {
    return { run: vi.fn<Run>(() => Promise.resolve(answer)), terminate: vi.fn() };
  }

  it('sends an inspect job and returns the answer', async () => {
    const fake = runner(inspectOk);
    const file = new Blob(['x']);
    expect(await inspectFile(fake, file)).toBe(inspectOk);
    expect(fake.run.mock.calls[0]?.[0]).toEqual({ kind: 'inspect', file });
  });

  it('passes the signal and turns progress into two numbers', async () => {
    const seen: [number, number][] = [];
    const controller = new AbortController();
    const fake = runner(inspectOk);
    fake.run.mockImplementation((_input, options) => {
      options?.onProgress?.({ completed: 1, total: 4 });
      return Promise.resolve(inspectOk);
    });
    await inspectFile(fake, new Blob(['x']), {
      signal: controller.signal,
      onProgress: (completed, total) => seen.push([completed, total]),
    });
    expect(seen).toEqual([[1, 4]]);
    expect((fake.run.mock.calls[0]?.[1] as { signal: AbortSignal }).signal).toBe(controller.signal);
  });

  it('works without a progress callback', async () => {
    const fake = runner(buildOk);
    fake.run.mockImplementation((_input, options) => {
      options?.onProgress?.({ completed: 1, total: 2 });
      return Promise.resolve(buildOk);
    });
    await expect(buildFiles(fake, [], [])).resolves.toBe(buildOk);
  });

  it('asks for checksums only when there is more than one output', async () => {
    const fake = runner(buildOk);
    const spec = { name: 'a.pdf', parts: [] };
    await buildFiles(fake, [], [spec]);
    await buildFiles(fake, [], [spec, spec]);
    await buildFiles(fake, [], []);
    expect(
      fake.run.mock.calls.map((call) => (call[0] as { withChecksums: boolean }).withChecksums),
    ).toEqual([false, true, false]);
  });

  it('refuses an answer of the other kind', async () => {
    await expect(inspectFile(runner(buildOk), new Blob(['x']))).rejects.toThrow(TypeError);
    await expect(buildFiles(runner(inspectOk), [], [])).rejects.toThrow(TypeError);
  });

  it('runs end to end with the engine', async () => {
    const ops = inProcessOps();
    const result = await inspectFile(ops, new Blob([await makePdf(3)]));
    expect(result).toMatchObject({ ok: true, pageCount: 3 });
  });
});

describe('the workers and their pools', () => {
  const served: {
    handler: (input: unknown, context: unknown) => unknown;
    options: Record<string, unknown>;
  }[] = [];

  beforeEach(() => {
    vi.resetModules();
    served.length = 0;
    vi.doMock('@stuffcloud/tools', async (original) => ({
      ...(await original<typeof Tools>()),
      serveWorker: (
        handler: (input: unknown, context: unknown) => unknown,
        options: Record<string, unknown>,
      ): void => {
        served.push({ handler, options });
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock('@stuffcloud/tools');
    vi.unstubAllGlobals();
  });

  it('serves PDF jobs from ops-worker with a guard and a transfer list', async () => {
    await import('../src/pdf/ops-worker.ts');
    expect(served).toHaveLength(1);
    const { handler, options } = served[0] ?? { handler: () => undefined, options: {} };
    expect(
      (options['accepts'] as (value: unknown) => boolean)({ kind: 'inspect', file: blob }),
    ).toBe(true);
    expect((options['accepts'] as (value: unknown) => boolean)({ kind: 'nope' })).toBe(false);
    const output = (await handler(
      { kind: 'inspect', file: new Blob([await makePdf(1)]) },
      { progress: vi.fn() },
    )) as PdfOutput;
    expect(output).toMatchObject({ ok: true, pageCount: 1 });
    expect((options['transfer'] as (output: PdfOutput) => object[])(output)).toEqual([]);
  });

  it('serves thumbnail jobs from thumbs-worker on an OffscreenCanvas and a parser worker of its own', async () => {
    const canvases: [number, number][] = [];
    const FakeOffscreen = vi.fn(function (this: unknown, width: number, height: number): void {
      canvases.push([width, height]);
    });
    const workers: { url: URL; options: WorkerOptions | undefined; terminate: () => void }[] = [];
    const FakeWorker = vi.fn(function (this: unknown, url: URL, options?: WorkerOptions): void {
      workers.push({ url, options, terminate: vi.fn() });
    });
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
    vi.stubGlobal('Worker', FakeWorker);
    const render = vi.fn(() => Promise.resolve({ ok: true, thumbs: [] }));
    vi.doMock('../src/pdf/thumbnails.ts', () => ({
      renderThumbnails: render,
      thumbTransfer: () => [],
    }));
    await import('../src/pdf/thumbs-worker.ts');
    const { handler, options } = served[0] ?? { handler: () => undefined, options: {} };
    expect(
      (options['accepts'] as (value: unknown) => boolean)({ file: blob, pages: [0], width: 300 }),
    ).toBe(true);
    expect((options['accepts'] as (value: unknown) => boolean)({ pages: [0] })).toBe(false);
    await handler({ file: blob, pages: [0], width: 300 }, { progress: vi.fn() });
    const deps = (
      render.mock.calls[0] as unknown as [
        unknown,
        { createCanvas: (w: number, h: number) => unknown; createParserWorker: () => unknown },
      ]
    )[1];
    deps.createCanvas(10, 20);
    expect(canvases).toEqual([[10, 20]]);
    deps.createParserWorker();
    expect(workers[0]?.url.pathname).toMatch(/pdf\.worker\.min\.mjs$/);
    expect(workers[0]?.options).toEqual({ type: 'module' });
    vi.doUnmock('../src/pdf/thumbnails.ts');
  });

  it('starts two workers per pool, each from its own file as a module', async () => {
    const created: { url: URL; options: WorkerOptions | undefined }[] = [];
    vi.stubGlobal(
      'Worker',
      class FakeWorker {
        readonly postMessage = vi.fn();
        readonly terminate = vi.fn();
        readonly addEventListener = vi.fn();
        constructor(url: URL, options?: WorkerOptions) {
          created.push({ url, options });
        }
      },
    );
    const { createOpsRunner, createThumbRunner, OPS_POOL_SIZE, THUMB_POOL_SIZE } =
      await import('../src/pdf/runners.ts');
    const ops = createOpsRunner();
    const thumbs = createThumbRunner();
    for (let job = 0; job < 3; job += 1) {
      void ops.run({ kind: 'inspect', file: blob }).catch(() => undefined);
      void thumbs.run({ file: blob, pages: [0], width: 100 }).catch(() => undefined);
    }
    ops.terminate();
    thumbs.terminate();
    expect(OPS_POOL_SIZE).toBe(2);
    expect(THUMB_POOL_SIZE).toBe(2);
    const names = created.map((entry) => entry.url.pathname.split('/').at(-1));
    expect(names.filter((name) => name === 'ops-worker.ts')).toHaveLength(2);
    expect(names.filter((name) => name === 'thumbs-worker.ts')).toHaveLength(2);
    expect(created.every((entry) => entry.options?.type === 'module')).toBe(true);
  });
});
