import { createWorkerPool } from '@stuffcloud/tools';
import type { PdfInput, PdfOutput, PdfRunner, ThumbInput, ThumbOutput } from './types.ts';

/**
 * The two pools of the PDF tools. They are separate on purpose: pictures of 500 pages must not
 * keep a merge waiting, and each worker holds its own copy of the file it works on, so both pools
 * stay small (ADR 0013). A tool creates its runners when it opens and terminates them when it goes.
 */

/** Workers for opening and building PDFs. */
export const OPS_POOL_SIZE = 2;

/** Workers for page pictures. */
export const THUMB_POOL_SIZE = 2;

export function createOpsRunner(): PdfRunner<PdfInput, PdfOutput> {
  return createWorkerPool<PdfInput, PdfOutput>({
    create: () => new Worker(new URL('./ops-worker.ts', import.meta.url), { type: 'module' }),
    size: OPS_POOL_SIZE,
  });
}

export function createThumbRunner(): PdfRunner<ThumbInput, ThumbOutput> {
  return createWorkerPool<ThumbInput, ThumbOutput>({
    create: () => new Worker(new URL('./thumbs-worker.ts', import.meta.url), { type: 'module' }),
    size: THUMB_POOL_SIZE,
  });
}
