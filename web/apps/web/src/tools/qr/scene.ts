/**
 * What a QR code looks like, as coloured rectangles in module units: the one description that the
 * SVG file, the PNG file, the preview and the scan test are all made from, so what is scanned is
 * what is downloaded.
 *
 * Two styles (docs/design/README.md): *raw* is black modules on white; *stuffcloud* has violet
 * modules, magenta finder squares and the mascot in the middle on a white patch. The patch hides
 * part of the data, which the error correction level H repairs, and the scan test (`check.ts`)
 * proves it for the very code that is shown.
 */

import { MASCOT, type PixelArt } from './mascot-art.ts';
import type { QrMatrix } from './matrix.ts';

export type QrStyle = 'raw' | 'stuffcloud';

export const QR_STYLES: readonly QrStyle[] = ['raw', 'stuffcloud'];

/** Width of the empty border around the code, in modules (ISO/IEC 18004: four). */
export const QUIET_ZONE = 4;

export const BACKGROUND = '#ffffff';
export const RAW_MODULE = '#000000';
export const VIOLET_MODULE = '#5b2fc9';
export const MAGENTA_FINDER = '#d6246e';

/** A rectangle in module units, the quiet zone included. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Rectangles of one colour; layers are painted in order, later ones on top. */
export interface Layer {
  readonly color: string;
  readonly rects: readonly Rect[];
}

export interface Scene {
  /** Modules per side with the quiet zone: the picture is a square of this size. */
  readonly side: number;
  readonly layers: readonly Layer[];
}

/** The 7 by 7 squares in three corners, as `[column, row]` of their top-left module. */
function finderOrigins(size: number): readonly (readonly [number, number])[] {
  return [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ];
}

function inFinder(size: number, column: number, row: number): boolean {
  return finderOrigins(size).some(
    ([left, top]) => column >= left && column < left + 7 && row >= top && row < top + 7,
  );
}

/** Dark modules as horizontal runs; `include` selects which modules count. */
function runs(
  matrix: QrMatrix,
  include: (column: number, row: number) => boolean,
): readonly Rect[] {
  const rects: Rect[] = [];
  for (let row = 0; row < matrix.size; row += 1) {
    let start = -1;
    for (let column = 0; column <= matrix.size; column += 1) {
      const filled =
        column < matrix.size && matrix.modules[row]?.[column] === true && include(column, row);
      if (filled && start < 0) {
        start = column;
      } else if (!filled && start >= 0) {
        rects.push({
          x: start + QUIET_ZONE,
          y: row + QUIET_ZONE,
          width: column - start,
          height: 1,
        });
        start = -1;
      }
    }
  }
  return rects;
}

/** Side of the white patch, in modules: about a third of the code, an odd number, at least five. */
export function patchSide(size: number): number {
  const side = Math.round(size * 0.3);
  return Math.max(5, side % 2 === 0 ? side + 1 : side);
}

/** The white patch and the mascot on it, centred on the code. */
function mascotLayers(size: number, art: PixelArt): readonly Layer[] {
  const side = patchSide(size);
  // The patch has one art pixel of margin on each side; the art pixel is a fraction of a module.
  const pixel = side / (art.width + 2);
  const patchHeight = pixel * (art.height + 2);
  const left = QUIET_ZONE + (size - side) / 2;
  const top = QUIET_ZONE + (size - patchHeight) / 2;
  const layers: Layer[] = [
    { color: BACKGROUND, rects: [{ x: left, y: top, width: side, height: patchHeight }] },
  ];
  const byColor = new Map<string, Rect[]>();
  for (const cell of art.cells) {
    const rects = byColor.get(cell.color) ?? [];
    rects.push({
      x: left + (cell.x + 1) * pixel,
      y: top + (cell.y + 1) * pixel,
      width: cell.width * pixel,
      height: pixel,
    });
    byColor.set(cell.color, rects);
  }
  for (const [color, rects] of byColor) {
    layers.push({ color, rects });
  }
  return layers;
}

export function buildScene(matrix: QrMatrix, style: QrStyle, art: PixelArt = MASCOT): Scene {
  const side = matrix.size + 2 * QUIET_ZONE;
  const background: Layer = {
    color: BACKGROUND,
    rects: [{ x: 0, y: 0, width: side, height: side }],
  };
  if (style === 'raw') {
    return { side, layers: [background, { color: RAW_MODULE, rects: runs(matrix, () => true) }] };
  }
  return {
    side,
    layers: [
      background,
      {
        color: VIOLET_MODULE,
        rects: runs(matrix, (column, row) => !inFinder(matrix.size, column, row)),
      },
      {
        color: MAGENTA_FINDER,
        rects: runs(matrix, (column, row) => inFinder(matrix.size, column, row)),
      },
      ...mascotLayers(matrix.size, art),
    ],
  };
}
