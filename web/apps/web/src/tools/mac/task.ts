import type { TaskContext } from '@stuffcloud/tools';
import { MAX_FILE_BYTES, MAX_FILES, parseOui, type OuiErrorCode } from './oui.ts';

/** The vendor lists the visitor chose. They are read here, in the worker, and never leave the browser. */
export interface Input {
  readonly files: readonly File[];
}

export interface FileSummary {
  readonly name: string;
  /** Entries that were read from the file. */
  readonly entries: number;
  /** Rows that were not a usable entry. */
  readonly skipped: number;
}

export type Output =
  | {
      readonly ok: true;
      readonly prefixes: readonly string[];
      readonly names: readonly string[];
      readonly files: readonly FileSummary[];
    }
  | {
      readonly ok: false;
      /** `too-large`: a file is bigger than `MAX_FILE_BYTES`. */
      readonly error: OuiErrorCode | 'too-large';
      /** The file the error is about. */
      readonly file: string;
    };

/** The page stops reading the files after this long (in milliseconds). */
export const LOAD_TIMEOUT_MS = 30_000;

export function isInput(value: unknown): value is Input {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { files } = value as { readonly files?: unknown };
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.length <= MAX_FILES &&
    files.every((file) => file instanceof File)
  );
}

/** Reads the files one after the other. It runs in the worker, so it must not touch the DOM. */
export async function runTask({ files }: Input, { progress }: TaskContext): Promise<Output> {
  const prefixes: string[] = [];
  const names: string[] = [];
  const summaries: FileSummary[] = [];
  progress(0, files.length);
  for (const [index, file] of files.entries()) {
    if (file.size > MAX_FILE_BYTES) {
      return { ok: false, error: 'too-large', file: file.name };
    }
    const parsed = parseOui(await file.text());
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, file: file.name };
    }
    for (const [at, prefix] of parsed.prefixes.entries()) {
      prefixes.push(prefix);
      names.push(parsed.names[at] ?? '');
    }
    summaries.push({ name: file.name, entries: parsed.prefixes.length, skipped: parsed.skipped });
    progress(index + 1, files.length);
  }
  return { ok: true, prefixes, names, files: summaries };
}
