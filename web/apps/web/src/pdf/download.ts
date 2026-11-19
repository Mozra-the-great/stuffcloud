import type { BuiltFile } from './types.ts';

/** A finished PDF the visitor can save: an object URL of this browser, never a network address. */
export interface ResultFile {
  readonly name: string;
  readonly url: string;
  readonly size: number;
  readonly pageCount: number;
  /** The same bytes as a `Blob`, for the ZIP. */
  readonly blob: Blob;
  readonly crc32: number;
}

export function toResult(file: BuiltFile): ResultFile {
  const blob = new Blob([file.bytes], { type: 'application/pdf' });
  return {
    name: file.name,
    url: URL.createObjectURL(blob),
    size: blob.size,
    pageCount: file.pageCount,
    blob,
    crc32: file.crc32,
  };
}

/** Gives the memory of the results back; the links stop working. */
export function release(results: readonly ResultFile[]): void {
  for (const result of results) {
    URL.revokeObjectURL(result.url);
  }
}
