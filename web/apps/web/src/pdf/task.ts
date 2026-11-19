import type { TaskContext } from '@stuffcloud/tools';
import { buildPdfs, inspectPdf } from './engine.ts';
import type { PdfInput, PdfOutput } from './types.ts';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isPick(value: unknown): boolean {
  return isRecord(value) && typeof value['index'] === 'number' && typeof value['turn'] === 'number';
}

function isPart(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['source'] === 'number' &&
    Array.isArray(value['pages']) &&
    value['pages'].every(isPick)
  );
}

function isSpec(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    Array.isArray(value['parts']) &&
    value['parts'].every(isPart)
  );
}

/** What arrives through `postMessage` is only typed by trust: check its shape before using it. */
export function isPdfInput(value: unknown): value is PdfInput {
  if (!isRecord(value)) {
    return false;
  }
  if (value['kind'] === 'inspect') {
    return value['file'] instanceof Blob;
  }
  return (
    value['kind'] === 'build' &&
    typeof value['withChecksums'] === 'boolean' &&
    Array.isArray(value['sources']) &&
    value['sources'].every((source) => source instanceof Blob) &&
    Array.isArray(value['outputs']) &&
    value['outputs'].every(isSpec)
  );
}

/** The work of the PDF worker: runs one job and reports progress in steps. */
export async function runPdfTask(input: PdfInput, { progress }: TaskContext): Promise<PdfOutput> {
  if (input.kind === 'inspect') {
    const result = await inspectPdf(input.file);
    progress(1, 1);
    return result;
  }
  return buildPdfs(input, progress);
}

/** The buffers of a finished job, moved to the page instead of copied. */
export function transferOf(output: PdfOutput): object[] {
  return output.kind === 'build' && output.ok ? output.files.map((file) => file.bytes.buffer) : [];
}
