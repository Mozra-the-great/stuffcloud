/**
 * The QR matrix: `uqr` encodes (ISO/IEC 18004), this module wraps it so that a text that does not
 * fit is a result and not an exception.
 */

import { encode } from 'uqr';

export type Ecc = 'L' | 'M' | 'Q' | 'H';

/** Error correction levels, strongest first (the order of the mock-up). */
export const ECC_LEVELS: readonly Ecc[] = ['H', 'Q', 'M', 'L'];

/** Longest text the tool takes; far above what the code can hold at level H, so the limit is the code's. */
export const MAX_TEXT_LENGTH = 4000;

export interface QrMatrix {
  /** Modules per side, without a quiet zone. */
  readonly size: number;
  /** QR version, 1 to 40. */
  readonly version: number;
  readonly ecc: Ecc;
  /** `modules[row][column]`: true is a dark module. */
  readonly modules: readonly (readonly boolean[])[];
}

export type MatrixError = 'empty' | 'too-long';

export type MatrixResult =
  | { readonly ok: true; readonly matrix: QrMatrix }
  | { readonly ok: false; readonly error: MatrixError };

export function encodeMatrix(text: string, ecc: Ecc): MatrixResult {
  if (text === '') {
    return { ok: false, error: 'empty' };
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return { ok: false, error: 'too-long' };
  }
  try {
    const code = encode(text, { ecc, border: 0, boostEcc: false });
    return {
      ok: true,
      matrix: { size: code.size, version: code.version, ecc, modules: code.data },
    };
  } catch {
    // `uqr` throws when the data needs more than version 40 at this level.
    return { ok: false, error: 'too-long' };
  }
}
