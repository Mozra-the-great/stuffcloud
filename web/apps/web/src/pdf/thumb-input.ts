import type { ThumbInput } from './types.ts';

/** Most pages one thumbnail job may ask for. */
export const MAX_THUMBS_PER_JOB = 1000;

/** What arrives through `postMessage` is only typed by trust: check the shape before using it. */
export function isThumbInput(value: unknown): value is ThumbInput {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const { pages, width } = record;
  return (
    record['file'] instanceof Blob &&
    typeof width === 'number' &&
    Number.isFinite(width) &&
    width >= 16 &&
    width <= 2048 &&
    Array.isArray(pages) &&
    pages.length <= MAX_THUMBS_PER_JOB &&
    pages.every((page) => Number.isSafeInteger(page) && (page as number) >= 0)
  );
}
