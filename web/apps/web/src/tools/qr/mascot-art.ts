/**
 * The mascot in the middle of the stuffcloud style: Stuffy, read from the design's pixel art
 * (`docs/design/prototypes/axo.svg`, one copy of the art for the whole app) as coloured cells.
 */

import axolotl from '../../../../../../docs/design/prototypes/axo.svg?raw';

export interface ArtCell {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly color: string;
}

export interface PixelArt {
  readonly width: number;
  readonly height: number;
  /** One cell per run of pixels of one colour in a row. */
  readonly cells: readonly ArtCell[];
}

const VIEW_BOX = /viewBox="0 0 (\d+) (\d+)"/;
const PATH = /<path fill="(#[0-9a-fA-F]{6})" d="([^"]*)"/g;
/** The art is written as `M<x> <y>h<w>v1h-<w>z`: a run of `w` pixels in row `y`. */
const RUN = /M(\d+) (\d+)h(\d+)v1h-\d+z/g;

/** Reads the pixel art out of one of the design's SVG files. */
export function parsePixelArt(svg: string): PixelArt {
  const box = VIEW_BOX.exec(svg);
  if (box === null) {
    throw new Error('the pixel art has no viewBox of the form "0 0 <width> <height>"');
  }
  const cells: ArtCell[] = [];
  for (const path of svg.matchAll(PATH)) {
    const color = (path[1] ?? '').toLowerCase();
    for (const run of (path[2] ?? '').matchAll(RUN)) {
      cells.push({
        x: Number(run[1]),
        y: Number(run[2]),
        width: Number(run[3]),
        color,
      });
    }
  }
  if (cells.length === 0) {
    throw new Error('the pixel art has no pixels');
  }
  return { width: Number(box[1]), height: Number(box[2]), cells };
}

export const MASCOT: PixelArt = parsePixelArt(axolotl);
