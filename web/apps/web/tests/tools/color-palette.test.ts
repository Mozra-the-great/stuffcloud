import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ImageError,
  MAX_IMAGE_BYTES,
  MAX_SIDE,
  readPixels,
  scaledSize,
} from '../../src/tools/color/image-pixels.ts';
import {
  DEFAULT_COLORS,
  extractPalette,
  MAX_COLORS,
  MIN_ALPHA,
  parseColorCount,
  type Pixels,
} from '../../src/tools/color/palette.ts';

type Rgba = readonly [number, number, number, number];

/** A `width` x `height` image whose pixel `index` is `colorOf(index)`. */
function image(width: number, height: number, colorOf: (index: number) => Rgba): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data.set(colorOf(index), index * 4);
  }
  return { data, width, height };
}

const solid = (color: Rgba) => (): Rgba => color;

describe('parseColorCount', () => {
  it.each([
    ['6', 6],
    [' 3 ', 3],
    ['2', 2],
    ['12', 12],
    ['1', 2],
    ['0', 2],
    ['-4', 2],
    ['13', 12],
    ['999', 12],
    ['4.6', 5],
    ['', DEFAULT_COLORS],
    ['  ', DEFAULT_COLORS],
    ['abc', DEFAULT_COLORS],
    ['Infinity', DEFAULT_COLORS],
  ])('turns %j into %i', (text, expected) => {
    expect(parseColorCount(text)).toBe(expected);
  });
});

describe('extractPalette', () => {
  it('finds the one colour of a solid image', () => {
    const palette = extractPalette(image(4, 4, solid([10, 20, 30, 255])), 6);
    expect(palette).toEqual([{ rgb: { r: 10, g: 20, b: 30 }, share: 1 }]);
  });

  it('finds exactly the colours of an image made of two, largest share first', () => {
    const picture = image(10, 10, (index) =>
      index < 70 ? [200, 30, 30, 255] : [20, 40, 220, 255],
    );
    const palette = extractPalette(picture, 6);
    expect(palette).toEqual([
      { rgb: { r: 200, g: 30, b: 30 }, share: 0.7 },
      { rgb: { r: 20, g: 40, b: 220 }, share: 0.3 },
    ]);
  });

  it('returns no more colours than asked for, and the shares add up to one', () => {
    const picture = image(16, 16, (index) => [index, 255 - index, (index * 7) % 256, 255]);
    for (const count of [1, 2, 3, 5, 8, 12]) {
      const palette = extractPalette(picture, count);
      expect(palette.length).toBeLessThanOrEqual(count);
      expect(palette.length).toBeGreaterThan(0);
      expect(palette.reduce((sum, color) => sum + color.share, 0)).toBeCloseTo(1, 9);
    }
    expect(extractPalette(picture, 6)).toHaveLength(6);
  });

  it('is deterministic and ordered by share', () => {
    const picture = image(16, 16, (index) => [index, (index * 3) % 256, 255 - index, 255]);
    const first = extractPalette(picture, 8);
    expect(extractPalette(picture, 8)).toEqual(first);
    const shares = first.map((color) => color.share);
    expect(shares).toEqual(shares.toSorted((a, b) => b - a));
  });

  it('clamps the requested count to 1 and to the maximum', () => {
    const picture = image(16, 16, (index) => [index, 255 - index, (index * 5) % 256, 255]);
    expect(extractPalette(picture, 0)).toHaveLength(1);
    expect(extractPalette(picture, 100).length).toBeLessThanOrEqual(MAX_COLORS);
  });

  it('skips transparent pixels, keeps pixels at the alpha limit', () => {
    const picture = image(2, 2, (index) => {
      if (index === 0) {
        return [255, 0, 0, MIN_ALPHA - 1];
      }
      if (index === 1) {
        return [0, 255, 0, MIN_ALPHA];
      }
      return [0, 0, 255, 255];
    });
    const colors = extractPalette(picture, 6).map((color) => color.rgb);
    expect(colors).toHaveLength(2);
    expect(colors).toContainEqual({ r: 0, g: 255, b: 0 });
    expect(colors).toContainEqual({ r: 0, g: 0, b: 255 });
    expect(colors).not.toContainEqual({ r: 255, g: 0, b: 0 });
  });

  it('gives an empty palette for an image without visible pixels and for an empty one', () => {
    expect(extractPalette(image(3, 3, solid([1, 2, 3, 0])), 6)).toEqual([]);
    expect(extractPalette({ data: [], width: 0, height: 0 }, 6)).toEqual([]);
  });

  it('ignores bytes beyond width times height and an incomplete last pixel', () => {
    const data = [9, 9, 9, 255, 1, 2, 3, 255, 7, 7, 7];
    const palette = extractPalette({ data, width: 1, height: 1 }, 6);
    expect(palette).toEqual([{ rgb: { r: 9, g: 9, b: 9 }, share: 1 }]);
    const short = extractPalette({ data, width: 5, height: 5 }, 6);
    expect(short.reduce((sum, color) => sum + color.share, 0)).toBeCloseTo(1, 9);
  });

  it('counts a byte that is missing from a sparse array as 0', () => {
    // Bytes 4 to 6 are holes: the array is sparse.
    const data: number[] = [10, 20, 30, 255];
    data[7] = 255;
    const palette = extractPalette({ data, width: 2, height: 1 }, 2);
    expect(palette.map((color) => color.rgb)).toEqual([
      { r: 0, g: 0, b: 0 },
      { r: 10, g: 20, b: 30 },
    ]);
  });

  it('splits on the widest channel, also where many pixels share one value', () => {
    // 3 pixels of one colour and one outlier: the median lies inside the run of equal values.
    const palette = extractPalette(
      image(2, 2, (index) => (index === 3 ? [250, 250, 250, 255] : [5, 5, 5, 255])),
      2,
    );
    expect(palette).toEqual([
      { rgb: { r: 5, g: 5, b: 5 }, share: 0.75 },
      { rgb: { r: 250, g: 250, b: 250 }, share: 0.25 },
    ]);
    // And the run is at the high end.
    const high = extractPalette(
      image(2, 2, (index) => (index === 0 ? [5, 5, 5, 255] : [250, 250, 250, 255])),
      2,
    );
    expect(high).toEqual([
      { rgb: { r: 250, g: 250, b: 250 }, share: 0.75 },
      { rgb: { r: 5, g: 5, b: 5 }, share: 0.25 },
    ]);
  });

  it('merges boxes whose average colour is the same', () => {
    const picture = image(2, 2, (index) =>
      index % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255],
    );
    // Two boxes, each one colour: no merge. With one box the average is grey.
    expect(extractPalette(picture, 2)).toHaveLength(2);
    expect(extractPalette(picture, 1)).toEqual([{ rgb: { r: 128, g: 128, b: 128 }, share: 1 }]);
  });
});

describe('scaledSize', () => {
  it('keeps small images and scales large ones to the maximum side', () => {
    expect(scaledSize(10, 20)).toEqual({ width: 10, height: 20 });
    expect(scaledSize(MAX_SIDE, MAX_SIDE)).toEqual({ width: MAX_SIDE, height: MAX_SIDE });
    expect(scaledSize(1920, 1080)).toEqual({ width: MAX_SIDE, height: 54 });
    expect(scaledSize(1080, 1920)).toEqual({ width: 54, height: MAX_SIDE });
  });

  it('never returns a side of zero', () => {
    expect(scaledSize(100_000, 1)).toEqual({ width: MAX_SIDE, height: 1 });
    expect(scaledSize(1, 1)).toEqual({ width: 1, height: 1 });
  });
});

describe('readPixels', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubBrowser(options: {
    bitmap?: { width: number; height: number };
    decode?: 'ok' | 'fail';
    context?: 'ok' | 'none';
  }): { close: ReturnType<typeof vi.fn>; draw: ReturnType<typeof vi.fn> } {
    const close = vi.fn();
    const draw = vi.fn();
    const size = options.bitmap ?? { width: 200, height: 100 };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() =>
        options.decode === 'fail'
          ? Promise.reject(new Error('not an image'))
          : Promise.resolve({ ...size, close }),
      ),
    );
    class FakeCanvas {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}

      getContext(): unknown {
        if (options.context === 'none') {
          return null;
        }
        return {
          drawImage: draw,
          getImageData: (_x: number, _y: number, width: number, height: number) => ({
            data: new Uint8ClampedArray(width * height * 4).fill(7),
          }),
        };
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    return { close, draw };
  }

  it('decodes, scales and returns the pixels, and releases the bitmap', async () => {
    const { close, draw } = stubBrowser({});
    const pixels = await readPixels(new Blob(['x'], { type: 'image/png' }));
    expect(pixels.width).toBe(96);
    expect(pixels.height).toBe(48);
    expect(pixels.data.length).toBe(96 * 48 * 4);
    expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0, 96, 48);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('refuses a file over the size limit before decoding it', async () => {
    stubBrowser({});
    const huge = { size: MAX_IMAGE_BYTES + 1 } as Blob;
    await expect(readPixels(huge)).rejects.toMatchObject({ name: 'ImageError', code: 'too-large' });
    expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
  });

  it('accepts a file exactly at the limit', async () => {
    stubBrowser({});
    const exact = { size: MAX_IMAGE_BYTES } as Blob;
    await expect(readPixels(exact)).resolves.toMatchObject({ width: 96 });
  });

  it('reports a file the browser cannot decode', async () => {
    stubBrowser({ decode: 'fail' });
    const error = await readPixels(new Blob(['x'])).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImageError);
    expect(error).toMatchObject({ code: 'unreadable' });
  });

  it('reports a missing 2D context and still releases the bitmap', async () => {
    const { close } = stubBrowser({ context: 'none' });
    await expect(readPixels(new Blob(['x']))).rejects.toMatchObject({ code: 'unreadable' });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
