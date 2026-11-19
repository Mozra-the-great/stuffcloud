/**
 * Building a QR code and proving that it scans. The proof decodes the picture that is going to be
 * shown and downloaded with `jsQR`, a reader that shares no code with the encoder (`uqr`), and
 * compares the text. A style that does not pass is not offered: the stuffcloud style falls back to
 * the raw one (docs/design/README.md).
 */

import jsQR from 'jsqr';
import { ECC_LEVELS, encodeMatrix, type Ecc, type MatrixError, type QrMatrix } from './matrix.ts';
import { rasterise, toRgba, toSvg } from './render.ts';
import { buildScene, type QrStyle, type Scene } from './scene.ts';

export { ECC_LEVELS };

/** Pixels per module of the picture the reader gets (a phone camera sees fewer, but gets a real photo). */
const SCAN_MIN_SCALE = 3;
const SCAN_TARGET_SIDE = 480;

/** What a reader sees in the scene; `undefined` when it finds no code. */
export function decodeScene(scene: Scene): string | undefined {
  const scale = Math.max(SCAN_MIN_SCALE, Math.ceil(SCAN_TARGET_SIDE / scene.side));
  const raster = rasterise(scene, scale);
  const found = jsQR(toRgba(raster), raster.width, raster.height, {
    inversionAttempts: 'dontInvert',
  });
  return found?.data;
}

/** The scan test: true when the reader finds exactly `text` in the picture. */
export type ScanTest = (scene: Scene, text: string) => boolean;

export const scanTest: ScanTest = (scene, text) => decodeScene(scene) === text;

export type QrFailure = MatrixError | 'scan-failed';

/** Why the stuffcloud style was not used. */
export type FallbackReason = 'capacity' | 'scan';

export interface QrCode {
  /** The style that is shown: the requested one unless it fell back. */
  readonly style: QrStyle;
  readonly fallback: FallbackReason | undefined;
  readonly matrix: QrMatrix;
  readonly scene: Scene;
  readonly svg: string;
}

export type QrResult =
  { readonly ok: true; readonly code: QrCode } | { readonly ok: false; readonly error: QrFailure };

type Attempt =
  { readonly ok: true; readonly code: QrCode } | { readonly ok: false; readonly error: QrFailure };

function attempt(text: string, style: QrStyle, ecc: Ecc, scan: ScanTest): Attempt {
  const encoded = encodeMatrix(text, ecc);
  if (!encoded.ok) {
    return { ok: false, error: encoded.error };
  }
  const scene = buildScene(encoded.matrix, style);
  if (!scan(scene, text)) {
    return { ok: false, error: 'scan-failed' };
  }
  return {
    ok: true,
    code: { style, fallback: undefined, matrix: encoded.matrix, scene, svg: toSvg(scene) },
  };
}

/**
 * The code for `text` in the requested style. The stuffcloud style always uses level H (it needs the
 * room); if that does not fit or the picture does not scan, the raw style at the chosen level is
 * made instead and `fallback` says why. The raw style has no way out: if it does not scan, that is
 * the result.
 */
export function buildQr(
  text: string,
  requested: { readonly style: QrStyle; readonly ecc: Ecc },
  scan: ScanTest = scanTest,
): QrResult {
  if (requested.style === 'stuffcloud') {
    const styled = attempt(text, 'stuffcloud', 'H', scan);
    if (styled.ok) {
      return styled;
    }
    if (styled.error === 'empty') {
      return styled;
    }
    const raw = attempt(text, 'raw', requested.ecc, scan);
    if (!raw.ok) {
      return raw;
    }
    return {
      ok: true,
      code: { ...raw.code, fallback: styled.error === 'too-long' ? 'capacity' : 'scan' },
    };
  }
  return attempt(text, 'raw', requested.ecc, scan);
}
