import type { TaskContext } from '@stuffcloud/tools';
import {
  MAX_DECODE_FILE_BYTES,
  MAX_FILE_BYTES,
  dataUri,
  decodeBase64,
  encodeBytes,
  isMediaType,
  wrapLines,
  type DecodeError,
  type EncodeOptions,
} from './codec.ts';

/** What the page sends to the worker: a file, to encode or to decode (its text is Base64). */
export type Input =
  | {
      readonly op: 'encode';
      readonly file: Blob;
      readonly options: EncodeOptions;
      /** Write a data URI of this media type (standard alphabet, padded, one line). */
      readonly mediaType?: string;
    }
  | { readonly op: 'decode'; readonly file: Blob };

export type Output =
  | { readonly ok: true; readonly kind: 'encoded'; readonly text: string; readonly size: number }
  | {
      readonly ok: true;
      readonly kind: 'decoded';
      readonly bytes: Uint8Array;
      readonly mediaType?: string;
    }
  | { readonly ok: false; readonly error: DecodeError };

/** The file is read in pieces of this many bytes (a multiple of 3, so no piece needs padding). */
export const CHUNK_BYTES = 3 * 1024 * 1024;

function isOptions(value: unknown): value is EncodeOptions {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record['urlSafe'] === 'boolean' &&
    typeof record['padding'] === 'boolean' &&
    (record['lineLength'] === 0 || record['lineLength'] === 64 || record['lineLength'] === 76)
  );
}

export function isInput(value: unknown): value is Input {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (!(record['file'] instanceof Blob)) {
    return false;
  }
  if (record['op'] === 'decode') {
    return true;
  }
  const mediaType = record['mediaType'];
  return (
    record['op'] === 'encode' &&
    isOptions(record['options']) &&
    (mediaType === undefined || (typeof mediaType === 'string' && isMediaType(mediaType)))
  );
}

/** Buffers of the output that move to the page instead of being copied. */
export function transfer(output: Output): object[] {
  return output.ok && output.kind === 'decoded' ? [output.bytes.buffer] : [];
}

/**
 * The work of the tool. It runs in the worker, so it must not touch the DOM. `chunkBytes` (a multiple of
 * three) is a parameter only so that a test can read a file in several pieces without megabytes of data.
 */
export async function runTask(
  input: Input,
  { progress }: TaskContext,
  chunkBytes: number = CHUNK_BYTES,
): Promise<Output> {
  const { file } = input;
  if (input.op === 'decode') {
    if (file.size > MAX_DECODE_FILE_BYTES) {
      throw new RangeError('the file is too large to decode');
    }
    const decoded = decodeBase64(await file.text());
    progress(1, 1);
    if (!decoded.ok) {
      return { ok: false, error: decoded.error };
    }
    return {
      ok: true,
      kind: 'decoded',
      bytes: decoded.bytes,
      ...(decoded.mediaType === undefined ? {} : { mediaType: decoded.mediaType }),
    };
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new RangeError('the file is too large to encode');
  }
  const asUri = input.mediaType !== undefined;
  const options: EncodeOptions = asUri
    ? { urlSafe: false, padding: true, lineLength: 0 }
    : input.options;
  const total = Math.max(file.size, 1);
  const parts: string[] = [];
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    const bytes = new Uint8Array(await file.slice(offset, offset + chunkBytes).arrayBuffer());
    // Only the last piece can end in a partial group (the others are a multiple of three bytes), so
    // only it has padding to write.
    parts.push(
      encodeBytes(bytes, { urlSafe: options.urlSafe, padding: options.padding, lineLength: 0 }),
    );
    progress(Math.min(offset + bytes.length, total), total);
  }
  const text = wrapLines(parts.join(''), options.lineLength);
  progress(total, total);
  return {
    ok: true,
    kind: 'encoded',
    text: input.mediaType === undefined ? text : dataUri(input.mediaType, text),
    size: file.size,
  };
}
