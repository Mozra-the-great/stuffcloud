/**
 * The two pictures made from a scene: an SVG document (vector, for the preview and the download)
 * and a raster of palette indices (for the PNG file and the scan test).
 */

import { SVG_NAMESPACE } from '../../app/svg-namespace.ts';
import type { Rect, Scene } from './scene.ts';

/** A number as short as possible with at most three decimals: `1.5`, `7`, `0.286`. */
function short(value: number): string {
  return String(Number(value.toFixed(3)));
}

function rectPath(rect: Rect): string {
  return `M${short(rect.x)} ${short(rect.y)}h${short(rect.width)}v${short(rect.height)}h${short(-rect.width)}z`;
}

/** The scene as a standalone SVG document without a fixed size: it scales to its box. */
export function toSvg(scene: Scene): string {
  const paths = scene.layers
    .map((layer) => `<path fill="${layer.color}" d="${layer.rects.map(rectPath).join('')}"/>`)
    .join('');
  const side = String(scene.side);
  return (
    `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">` +
    `${paths}</svg>`
  );
}

export type Rgb = readonly [red: number, green: number, blue: number];

export function parseHexColor(color: string): Rgb {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (match === null) {
    throw new Error(`not a #rrggbb colour: ${color}`);
  }
  return [
    Number.parseInt(match[1] ?? '', 16),
    Number.parseInt(match[2] ?? '', 16),
    Number.parseInt(match[3] ?? '', 16),
  ];
}

/** A picture of palette indices: one byte per pixel, row by row. */
export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly palette: readonly Rgb[];
  readonly pixels: Uint8Array;
}

/**
 * Paints the scene with `scale` pixels per module into a square of `side` pixels (the code is
 * centred, the rest is the background colour). Edges fall on whole pixels, rounded the same way for
 * every rectangle, so neighbouring rectangles never leave a gap.
 */
export function rasterise(scene: Scene, scale: number, side: number = scene.side * scale): Raster {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new RangeError(`the scale must be a whole number of pixels, got ${String(scale)}`);
  }
  if (!Number.isInteger(side) || side < scene.side * scale) {
    throw new RangeError(
      `a ${String(side)} px picture cannot hold ${String(scene.side)} modules at ${String(scale)} px`,
    );
  }
  const offset = Math.floor((side - scene.side * scale) / 2);
  const palette: Rgb[] = [];
  const pixels = new Uint8Array(side * side);
  for (const [index, layer] of scene.layers.entries()) {
    palette.push(parseHexColor(layer.color));
    for (const rect of layer.rects) {
      const left = offset + Math.round(rect.x * scale);
      const right = offset + Math.round((rect.x + rect.width) * scale);
      const top = offset + Math.round(rect.y * scale);
      const bottom = offset + Math.round((rect.y + rect.height) * scale);
      for (let row = top; row < bottom; row += 1) {
        pixels.fill(index, row * side + left, row * side + right);
      }
    }
  }
  // The margin outside the code stays index 0, the background colour of the first layer.
  return { width: side, height: side, palette, pixels };
}

/** The picture as RGBA bytes (what a canvas and the QR reader take). */
export function toRgba(raster: Raster): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(raster.width * raster.height * 4);
  for (const [index, paletteIndex] of raster.pixels.entries()) {
    const [red, green, blue] = raster.palette[paletteIndex] ?? [255, 255, 255];
    rgba[index * 4] = red;
    rgba[index * 4 + 1] = green;
    rgba[index * 4 + 2] = blue;
    rgba[index * 4 + 3] = 255;
  }
  return rgba;
}
