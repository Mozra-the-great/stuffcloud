/**
 * What one PDF operation may take on (memory guard, ADR 0013). A PDF is parsed into objects, so
 * the memory a job needs is a multiple of the file size; the limits keep a tab alive on an
 * ordinary laptop and make the refusal a clear message instead of a crashed tab.
 */

const MIB = 1024 * 1024;

/** All files of one operation together (merge adds them up). */
export const MAX_TOTAL_INPUT_BYTES = 400 * MIB;

/** Pages of one operation (merge adds them up); also the largest document the page editor opens. */
export const MAX_TOTAL_PAGES = 10_000;

/** Files one operation may produce (split) and the entries of the ZIP that holds them. */
export const MAX_OUTPUT_FILES = 1000;

/** Files a merge takes. */
export const MAX_MERGE_FILES = 200;

/** Whether `bytes` (all inputs of an operation together) fit within the memory guard. */
export function fitsInputLimit(bytes: number): boolean {
  return bytes <= MAX_TOTAL_INPUT_BYTES;
}
