import type { Rgb } from './color.ts';

/** RGBA bytes of an image, as `ImageData` has them (the part of it the palette needs). */
export interface Pixels {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

export interface PaletteColor {
  readonly rgb: Rgb;
  /** Share of the visible pixels that this colour stands for, 0 to 1. */
  readonly share: number;
}

/** Pixels with less alpha than this are skipped: they show the page behind, not the image. */
export const MIN_ALPHA = 128;

export const MIN_COLORS = 2;
export const MAX_COLORS = 12;
export const DEFAULT_COLORS = 6;

/** The number of colours asked for, as the whole number it can be: out of range or unreadable text falls back. */
export function parseColorCount(text: string): number {
  const value = Number(text.trim());
  if (text.trim() === '' || !Number.isFinite(value)) {
    return DEFAULT_COLORS;
  }
  return Math.min(MAX_COLORS, Math.max(MIN_COLORS, Math.round(value)));
}

type Channel = 0 | 1 | 2;
interface Box {
  /** Packed pixels: `r * 65536 + g * 256 + b`. */
  readonly pixels: number[];
}

const red = (packed: number): number => Math.floor(packed / 65536);
const green = (packed: number): number => Math.floor(packed / 256) % 256;
const blue = (packed: number): number => packed % 256;
const component = (packed: number, channel: Channel): number =>
  channel === 0 ? red(packed) : channel === 1 ? green(packed) : blue(packed);

/** A byte of the image data; a byte that is not there (a sparse array) counts as 0. */
function byte(data: ArrayLike<number>, index: number): number {
  return data[index] ?? 0;
}

/** The channel with the widest spread in the box, and that spread. */
function widestChannel(box: Box): { channel: Channel; range: number } {
  let best: { channel: Channel; range: number } = { channel: 0, range: -1 };
  for (const channel of [0, 1, 2] as const) {
    let min = 255;
    let max = 0;
    for (const packed of box.pixels) {
      const value = component(packed, channel);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    if (max - min > best.range) {
      best = { channel, range: max - min };
    }
  }
  return best;
}

function average(box: Box): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const packed of box.pixels) {
    r += red(packed);
    g += green(packed);
    b += blue(packed);
  }
  const count = box.pixels.length;
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}

/**
 * The dominant colours of an image by median cut: all visible pixels start in one box; the box
 * with the most pixels that still has more than one colour is cut at the median of its widest
 * channel, until there are `count` boxes. Each box is represented by its average colour. The result
 * is ordered by share, largest first (equal shares by colour), so the same image always gives
 * the same palette. An image without visible pixels gives an empty palette.
 */
export function extractPalette(pixels: Pixels, count: number): readonly PaletteColor[] {
  const wanted = Math.min(MAX_COLORS, Math.max(1, Math.round(count)));
  const visible: number[] = [];
  const total = Math.min(Math.floor(pixels.data.length / 4), pixels.width * pixels.height);
  for (let index = 0; index < total; index += 1) {
    if (byte(pixels.data, index * 4 + 3) >= MIN_ALPHA) {
      visible.push(
        byte(pixels.data, index * 4) * 65536 +
          byte(pixels.data, index * 4 + 1) * 256 +
          byte(pixels.data, index * 4 + 2),
      );
    }
  }
  if (visible.length === 0) {
    return [];
  }

  const boxes: Box[] = [{ pixels: visible }];
  while (boxes.length < wanted) {
    let target: Box | undefined;
    let targetIndex = -1;
    for (const [index, box] of boxes.entries()) {
      if (
        widestChannel(box).range > 0 &&
        (target === undefined || box.pixels.length > target.pixels.length)
      ) {
        target = box;
        targetIndex = index;
      }
    }
    if (target === undefined) {
      break;
    }
    const { channel } = widestChannel(target);
    const sorted = [...target.pixels].sort(
      (a, b) => component(a, channel) - component(b, channel) || a - b,
    );
    // Cut between two different values of the channel, nearest to the median: the first such place
    // at or after the median, else the last one before it (the box has at least two values).
    const middle = Math.floor(sorted.length / 2);
    const keys = sorted.map((packed) => component(packed, channel));
    const after = keys.findIndex((key, index) => index >= middle && key !== keys[index - 1]);
    const cut =
      after === -1
        ? keys.findLastIndex((key, index) => index > 0 && key !== keys[index - 1])
        : after;
    boxes.splice(targetIndex, 1, { pixels: sorted.slice(0, cut) }, { pixels: sorted.slice(cut) });
  }

  const merged = new Map<number, number>();
  for (const box of boxes) {
    const { r, g, b } = average(box);
    const key = r * 65536 + g * 256 + b;
    merged.set(key, (merged.get(key) ?? 0) + box.pixels.length);
  }
  return [...merged.entries()]
    .sort(([colorA, sizeA], [colorB, sizeB]) => sizeB - sizeA || colorA - colorB)
    .map(([key, size]) => ({
      rgb: { r: red(key), g: green(key), b: blue(key) },
      share: size / visible.length,
    }));
}
