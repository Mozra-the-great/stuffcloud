import { crc32 as nodeCrc32 } from 'node:zlib';
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { readPng } from './qr-helpers.ts';
import {
  ECC_LEVELS,
  buildQr,
  decodeScene,
  scanTest,
  type QrCode,
  type ScanTest,
} from '../../src/tools/qr/check.ts';
import { MASCOT, parsePixelArt } from '../../src/tools/qr/mascot-art.ts';
import { MAX_TEXT_LENGTH, encodeMatrix, type Ecc } from '../../src/tools/qr/matrix.ts';
import { contactPayload, wifiPayload } from '../../src/tools/qr/payload.ts';
import { crc32, encodePng } from '../../src/tools/qr/png.ts';
import { parseHexColor, rasterise, toRgba, toSvg, type Raster } from '../../src/tools/qr/render.ts';
import {
  BACKGROUND,
  MAGENTA_FINDER,
  QUIET_ZONE,
  VIOLET_MODULE,
  buildScene,
  patchSide,
  type QrStyle,
} from '../../src/tools/qr/scene.ts';

function code(text: string, style: QrStyle, ecc: Ecc = 'H'): QrCode {
  const result = buildQr(text, { style, ecc });
  if (!result.ok) {
    throw new Error(`no code: ${result.error}`);
  }
  return result.code;
}

describe('encodeMatrix', () => {
  it('gives a square of modules with the finder squares in three corners', () => {
    const result = encodeMatrix('hello', 'H');
    if (!result.ok) {
      throw new Error('expected a matrix');
    }
    const { matrix } = result;
    expect(matrix.size).toBe(21);
    expect(matrix.version).toBe(1);
    expect(matrix.ecc).toBe('H');
    expect(matrix.modules).toHaveLength(21);
    for (const row of matrix.modules) {
      expect(row).toHaveLength(21);
    }
    // The outer ring of a finder square is dark.
    for (const [column, row] of [
      [0, 0],
      [6, 0],
      [0, 6],
      [20, 0],
      [14, 0],
      [0, 20],
    ] as const) {
      expect(matrix.modules[row]?.[column]).toBe(true);
    }
    // The centre of the square is dark, the ring inside the outer one is light.
    expect(matrix.modules[3]?.[3]).toBe(true);
    expect(matrix.modules[1]?.[1]).toBe(false);
  });

  it('needs a larger version for a longer text and for a higher level', () => {
    const version = (text: string, ecc: Ecc): number => {
      const result = encodeMatrix(text, ecc);
      return result.ok ? result.matrix.version : -1;
    };
    expect(version('a'.repeat(100), 'L')).toBeLessThan(version('a'.repeat(100), 'H'));
    expect(version('a'.repeat(10), 'M')).toBeLessThan(version('a'.repeat(500), 'M'));
  });

  it('reports an empty text, a text over the limit and a text the code cannot hold', () => {
    expect(encodeMatrix('', 'H')).toEqual({ ok: false, error: 'empty' });
    expect(encodeMatrix('a'.repeat(MAX_TEXT_LENGTH + 1), 'L')).toEqual({
      ok: false,
      error: 'too-long',
    });
    // 1274 bytes fit at level L (up to 2953) but not at level H (up to 1273).
    expect(encodeMatrix('a'.repeat(1273), 'H').ok).toBe(true);
    expect(encodeMatrix('a'.repeat(1274), 'H')).toEqual({ ok: false, error: 'too-long' });
    expect(encodeMatrix('a'.repeat(1274), 'L').ok).toBe(true);
    expect(encodeMatrix('a'.repeat(MAX_TEXT_LENGTH), 'L')).toEqual({
      ok: false,
      error: 'too-long',
    });
  });
});

describe('the mascot art', () => {
  it('is read from the design file: 16 by 11 pixels in five colours', () => {
    expect(MASCOT.width).toBe(16);
    expect(MASCOT.height).toBe(11);
    expect(new Set(MASCOT.cells.map((cell) => cell.color))).toEqual(
      new Set(['#ff4f8b', '#ffa6c4', '#1a0b14', '#ffffff', '#ff7aa6', '#8a1f4a']),
    );
    for (const cell of MASCOT.cells) {
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.x + cell.width).toBeLessThanOrEqual(16);
      expect(cell.y).toBeGreaterThanOrEqual(0);
      expect(cell.y).toBeLessThan(11);
    }
  });

  it('reads runs of pixels and refuses art that has no size or no pixels', () => {
    const art = parsePixelArt(
      '<svg viewBox="0 0 4 2"><path fill="#AABBCC" d="M1 0h2v1h-2zM0 1h1v1h-1z"/><path fill="#112233" d="M3 1h1v1h-1z"/></svg>',
    );
    expect(art).toEqual({
      width: 4,
      height: 2,
      cells: [
        { x: 1, y: 0, width: 2, color: '#aabbcc' },
        { x: 0, y: 1, width: 1, color: '#aabbcc' },
        { x: 3, y: 1, width: 1, color: '#112233' },
      ],
    });
    expect(() => parsePixelArt('<svg><path fill="#aabbcc" d="M0 0h1v1h-1z"/></svg>')).toThrow(
      'viewBox',
    );
    expect(() => parsePixelArt('<svg viewBox="0 0 4 2"></svg>')).toThrow('no pixels');
  });
});

describe('the scene', () => {
  const matrix = (() => {
    const result = encodeMatrix('stuffcloud', 'H');
    if (!result.ok) {
      throw new Error('expected a matrix');
    }
    return result.matrix;
  })();

  it('raw: black modules on white with a quiet zone of four modules', () => {
    const scene = buildScene(matrix, 'raw');
    expect(scene.side).toBe(matrix.size + 2 * QUIET_ZONE);
    expect(scene.layers.map((layer) => layer.color)).toEqual(['#ffffff', '#000000']);
    const dark = scene.layers[1]?.rects ?? [];
    const area = dark.reduce((sum, rect) => sum + rect.width * rect.height, 0);
    const modules = matrix.modules.flat().filter(Boolean).length;
    expect(area).toBe(modules);
    for (const rect of dark) {
      expect(rect.x).toBeGreaterThanOrEqual(QUIET_ZONE);
      expect(rect.x + rect.width).toBeLessThanOrEqual(QUIET_ZONE + matrix.size);
      expect(rect.height).toBe(1);
    }
  });

  it('stuffcloud: violet modules, magenta finders, a white patch and the mascot', () => {
    const scene = buildScene(matrix, 'stuffcloud');
    const colors = scene.layers.map((layer) => layer.color);
    expect(colors.slice(0, 3)).toEqual([BACKGROUND, VIOLET_MODULE, MAGENTA_FINDER]);
    expect(colors[3]).toBe(BACKGROUND);
    expect(new Set(colors.slice(4))).toEqual(new Set(MASCOT.cells.map((cell) => cell.color)));
    const finder = scene.layers[2]?.rects ?? [];
    // Three finder squares: 24 + 16 + ... dark modules each (a 7x7 square has 33 dark ones in 1x7 / 5x1 runs).
    const finderArea = finder.reduce((sum, rect) => sum + rect.width * rect.height, 0);
    expect(finderArea).toBe(3 * 33);
    const violet = scene.layers[1]?.rects ?? [];
    const all = matrix.modules.flat().filter(Boolean).length;
    expect(violet.reduce((sum, rect) => sum + rect.width * rect.height, 0)).toBe(all - 3 * 33);
  });

  it('puts the patch in the middle, an odd number of modules wide, at most a third of the code', () => {
    for (const size of [21, 25, 29, 45, 77, 145, 177]) {
      const side = patchSide(size);
      expect(side % 2).toBe(1);
      expect(side).toBeGreaterThanOrEqual(5);
      expect(side).toBeLessThanOrEqual(Math.ceil(size / 3) + 1);
    }
    expect(patchSide(21)).toBe(7);
    expect(patchSide(25)).toBe(9);
    expect(patchSide(29)).toBe(9);
    expect(patchSide(10)).toBe(5);
    const scene = buildScene(matrix, 'stuffcloud');
    const patch = scene.layers[3]?.rects[0];
    expect(patch).toBeDefined();
    if (patch === undefined) {
      return;
    }
    expect(patch.x + patch.width / 2).toBeCloseTo(scene.side / 2, 9);
    expect(patch.y + patch.height / 2).toBeCloseTo(scene.side / 2, 9);
    expect(patch.width).toBe(patchSide(matrix.size));
    // Every mascot pixel lies inside the patch.
    for (const layer of scene.layers.slice(4)) {
      for (const rect of layer.rects) {
        expect(rect.x).toBeGreaterThanOrEqual(patch.x - 1e-9);
        expect(rect.x + rect.width).toBeLessThanOrEqual(patch.x + patch.width + 1e-9);
        expect(rect.y).toBeGreaterThanOrEqual(patch.y - 1e-9);
        expect(rect.y + rect.height).toBeLessThanOrEqual(patch.y + patch.height + 1e-9);
      }
    }
  });

  it('keeps the patch clear of the finder squares for every version', () => {
    for (let version = 1; version <= 40; version += 1) {
      const size = 17 + 4 * version;
      const side = patchSide(size);
      const height = (side / (MASCOT.width + 2)) * (MASCOT.height + 2);
      // The finder squares are 7 modules wide and high in three corners: a patch whose top edge is
      // below row 7 touches none of them.
      expect((size - height) / 2).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('the SVG', () => {
  it('is a standalone document with a viewBox and one path per colour', () => {
    const { svg } = code('https://example.org', 'stuffcloud');
    expect(svg.startsWith('<svg xmlns="')).toBe(true);
    const { scene } = code('https://example.org', 'stuffcloud');
    expect(svg).toContain(`viewBox="0 0 ${String(scene.side)} ${String(scene.side)}"`);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg.match(/<path /g)?.length).toBe(
      code('https://example.org', 'stuffcloud').scene.layers.length,
    );
    expect(svg).toContain(`fill="${VIOLET_MODULE}"`);
    expect(svg).toContain(`fill="${MAGENTA_FINDER}"`);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('undefined');
  });

  it('writes whole numbers plainly and fractions with at most three decimals', () => {
    const svg = toSvg({
      side: 10,
      layers: [
        { color: '#000000', rects: [{ x: 1, y: 2.5, width: 0.28571428, height: 3 }] },
        { color: '#ffffff', rects: [{ x: 0.0004, y: 0, width: 1, height: 1 }] },
      ],
    });
    expect(svg).toContain('d="M1 2.5h0.286v3h-0.286z"');
    expect(svg).toContain('d="M0 0h1v1h-1z"');
  });
});

describe('the raster', () => {
  it('paints modules as squares of whole pixels and centres the code', () => {
    const result = code('hi', 'raw');
    const scene = result.scene;
    const raster = rasterise(scene, 4, scene.side * 4 + 10);
    expect(raster.width).toBe(scene.side * 4 + 10);
    expect(raster.palette).toEqual([
      [255, 255, 255],
      [0, 0, 0],
    ]);
    // The margin is background, the top-left finder module (4, 4) is black.
    expect(raster.pixels[0]).toBe(0);
    const at = (column: number, row: number): number =>
      raster.pixels[row * raster.width + column] ?? -1;
    expect(at(5 + 4 * 4, 5 + 4 * 4)).toBe(1);
    expect(at(5 + 4 * 4 - 1, 5 + 4 * 4)).toBe(0);
    expect(at(5 + 4 * 4 + 3, 5 + 4 * 4 + 3)).toBe(1);
    // Dark modules: each takes scale squared pixels.
    const modules = result.matrix.modules.flat().filter(Boolean).length;
    expect(raster.pixels.filter((pixel) => pixel === 1).length).toBe(modules * 16);
  });

  it('defaults to the exact size and refuses a scale or a size that does not fit', () => {
    const { scene } = code('hi', 'raw');
    expect(rasterise(scene, 3).width).toBe(scene.side * 3);
    expect(() => rasterise(scene, 0)).toThrow('whole number');
    expect(() => rasterise(scene, 1.5)).toThrow('whole number');
    expect(() => rasterise(scene, 3, scene.side * 3 - 1)).toThrow('cannot hold');
    expect(() => rasterise(scene, 3, 100.5)).toThrow('cannot hold');
  });

  it('turns palette indices into opaque RGBA', () => {
    const raster: Raster = {
      width: 2,
      height: 1,
      palette: [
        [1, 2, 3],
        [4, 5, 6],
      ],
      pixels: Uint8Array.of(1, 0),
    };
    expect([...toRgba(raster)]).toEqual([4, 5, 6, 255, 1, 2, 3, 255]);
  });

  it('parses #rrggbb colours and refuses anything else', () => {
    expect(parseHexColor('#5b2fc9')).toEqual([0x5b, 0x2f, 0xc9]);
    expect(parseHexColor('#FFFFFF')).toEqual([255, 255, 255]);
    for (const bad of ['', '#fff', 'red', '#12345g', '5b2fc9']) {
      expect(() => parseHexColor(bad)).toThrow('not a #rrggbb colour');
    }
  });
});

describe('the PNG file', () => {
  it('has a CRC that matches zlib and the example value of the PNG specification', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const bytes = Uint8Array.from({ length: 1000 }, (_, index) => (index * 31 + 7) % 256);
    expect(crc32(bytes)).toBe(nodeCrc32(bytes));
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('is a valid indexed PNG that reads back to the same pixels', async () => {
    for (const style of ['raw', 'stuffcloud'] as const) {
      const { scene } = code('PNG round trip', style);
      const raster = rasterise(scene, 6);
      const read = readPng(await encodePng(raster));
      expect(read.width).toBe(raster.width);
      expect(read.height).toBe(raster.height);
      expect(read.palette).toEqual(raster.palette.map(([r, g, b]) => [r, g, b]));
      expect(read.pixels).toEqual(raster.pixels);
    }
  });

  it('can be decoded by an independent reader after being written and read back', async () => {
    const text = 'Scan me: https://example.org/path?x=1&y=2 — grüße 日本語 😀';
    for (const style of ['raw', 'stuffcloud'] as const) {
      const { scene } = code(text, style);
      const raster = readPng(await encodePng(rasterise(scene, 8)));
      const found = jsQR(toRgba(raster), raster.width, raster.height);
      expect(found?.data).toBe(text);
    }
  });

  it('is the exact size asked for, with the code centred', async () => {
    const { scene } = code('size', 'raw');
    for (const side of [512, 1024, 2048]) {
      const scale = Math.floor(side / scene.side);
      const raster = rasterise(scene, scale, side);
      expect(raster.width).toBe(side);
      expect(raster.height).toBe(side);
    }
    const png = await encodePng(rasterise(scene, 4, 400));
    const view = new DataView(png.buffer);
    expect(view.getUint32(16)).toBe(400);
    expect(view.getUint32(20)).toBe(400);
  });

  it('compresses a large picture well (2048 px in well under a megabyte)', async () => {
    const { scene } = code('x'.repeat(100), 'stuffcloud');
    const side = 2048;
    const png = await encodePng(rasterise(scene, Math.floor(side / scene.side), side));
    expect(png.length).toBeLessThan(200_000);
  });

  it('refuses a palette that does not fit and pixels that do not fill the picture', async () => {
    const pixels = new Uint8Array(4);
    await expect(encodePng({ width: 2, height: 2, palette: [], pixels })).rejects.toThrow(
      '1 to 256 colours',
    );
    await expect(
      encodePng({
        width: 2,
        height: 2,
        palette: Array.from({ length: 257 }, () => [0, 0, 0] as const),
        pixels,
      }),
    ).rejects.toThrow('1 to 256 colours');
    await expect(encodePng({ width: 2, height: 3, palette: [[0, 0, 0]], pixels })).rejects.toThrow(
      'do not fill',
    );
  });
});

describe('the scan test', () => {
  it('finds the text in a picture of the code and nothing in a blank one', () => {
    const { scene } = code('find me', 'raw');
    expect(decodeScene(scene)).toBe('find me');
    expect(scanTest(scene, 'find me')).toBe(true);
    expect(scanTest(scene, 'something else')).toBe(false);
    expect(
      decodeScene({
        side: scene.side,
        layers: [scene.layers[0] ?? { color: '#ffffff', rects: [] }],
      }),
    ).toBeUndefined();
  });

  it('fails when the code is damaged beyond repair', () => {
    const { scene } = code('this will not survive', 'raw');
    // Cover the middle of the code with a white block the error correction cannot repair.
    const blocked = {
      side: scene.side,
      layers: [
        ...scene.layers,
        {
          color: '#ffffff',
          rects: [{ x: 7, y: 7, width: scene.side - 14, height: scene.side - 14 }],
        },
      ],
    };
    expect(scanTest(blocked, 'this will not survive')).toBe(false);
  });

  it('does not read a code with swapped colours (the inversion is not tried)', () => {
    const { scene } = code('inverted', 'raw');
    const inverted = {
      side: scene.side,
      layers: scene.layers.map((layer) => ({
        ...layer,
        color: layer.color === '#ffffff' ? '#000000' : '#ffffff',
      })),
    };
    expect(decodeScene(inverted)).toBeUndefined();
  });
});

describe('buildQr: every style, level and kind of text scans', () => {
  const wifi = wifiPayload({ ssid: 'My;Net', password: 'p"a:s,s', security: 'WPA', hidden: true });
  const vcard = contactPayload({
    firstName: 'Ada',
    lastName: 'Lovelace',
    organisation: 'Analytical',
    phone: '+49 30 1234567',
    email: 'ada@example.org',
    website: 'https://example.org',
  });
  const texts: readonly string[] = [
    'a',
    'hello world',
    'https://example.org/some/long/path?with=query&and=more#fragment',
    'Grüße aus Köln — 日本語のテキスト 😀🎉',
    '0123456789'.repeat(20),
    'line one\nline two\r\nline three',
    wifi.ok ? wifi.text : '',
    vcard.ok ? vcard.text : '',
  ];

  it.each(texts.map((text) => [text.slice(0, 24).replaceAll('\n', ' '), text] as const))(
    'text %j scans in every combination',
    (_, text) => {
      for (const style of ['raw', 'stuffcloud'] as const) {
        for (const ecc of ECC_LEVELS) {
          const result = buildQr(text, { style, ecc });
          expect(result.ok, `${style} ${ecc}`).toBe(true);
          if (result.ok) {
            expect(result.code.fallback).toBeUndefined();
            expect(decodeScene(result.code.scene)).toBe(text);
            expect(result.code.style).toBe(style);
            expect(result.code.matrix.ecc).toBe(style === 'stuffcloud' ? 'H' : ecc);
          }
        }
      }
    },
  );

  it(
    'scans the stuffcloud style for every length from 1 to 200 characters',
    { timeout: 180_000 },
    () => {
      // Every version from 1 to 15 at level H, with the mascot in the middle.
      const failures: number[] = [];
      for (let length = 1; length <= 200; length += 5) {
        const text = Array.from({ length }, (_, index) =>
          String.fromCharCode(33 + ((index * 7 + length) % 90)),
        ).join('');
        const result = buildQr(text, { style: 'stuffcloud', ecc: 'H' });
        if (
          !result.ok ||
          result.code.style !== 'stuffcloud' ||
          decodeScene(result.code.scene) !== text
        ) {
          failures.push(length);
        }
      }
      expect(failures).toEqual([]);
    },
  );

  it(
    'scans random text of random length in both styles (a property test with a seeded generator)',
    { timeout: 120_000 },
    () => {
      let state = 12345;
      const next = (limit: number): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return Math.floor((state / 4_294_967_296) * limit);
      };
      const alphabet = 'abcXYZ019 -_./:?&=#%+äöüß日本語😀\n';
      const characters = Array.from(new Intl.Segmenter().segment(alphabet), (part) => part.segment);
      for (let round = 0; round < 40; round += 1) {
        const length = 1 + next(400);
        const text = Array.from({ length }, () => characters[next(characters.length)] ?? 'a').join(
          '',
        );
        for (const style of ['raw', 'stuffcloud'] as const) {
          const ecc = ECC_LEVELS[next(ECC_LEVELS.length)] ?? 'H';
          const result = buildQr(text, { style, ecc });
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.code.fallback).toBeUndefined();
            expect(decodeScene(result.code.scene)).toBe(text);
          }
        }
      }
    },
  );
});

describe('buildQr: fallbacks and failures', () => {
  const never: ScanTest = () => false;

  it('refuses an empty text in both styles and does not fall back for it', () => {
    expect(buildQr('', { style: 'raw', ecc: 'H' })).toEqual({ ok: false, error: 'empty' });
    expect(buildQr('', { style: 'stuffcloud', ecc: 'H' })).toEqual({ ok: false, error: 'empty' });
  });

  it('falls back from the stuffcloud style to raw when the styled picture does not scan', () => {
    const scanned: QrStyle[] = [];
    const scan: ScanTest = (scene) => {
      const styled = scene.layers.length > 2;
      scanned.push(styled ? 'stuffcloud' : 'raw');
      return !styled;
    };
    const result = buildQr('fallback', { style: 'stuffcloud', ecc: 'M' }, scan);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code.style).toBe('raw');
      expect(result.code.fallback).toBe('scan');
      // The raw code is made at the level the visitor chose, not at H.
      expect(result.code.matrix.ecc).toBe('M');
      expect(result.code.scene.layers).toHaveLength(2);
      expect(result.code.svg).toBe(toSvg(result.code.scene));
    }
    expect(scanned).toEqual(['stuffcloud', 'raw']);
  });

  it('falls back to raw when the text does not fit at level H but fits at the chosen level', () => {
    const text = 'a'.repeat(1500);
    const result = buildQr(text, { style: 'stuffcloud', ecc: 'L' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code.style).toBe('raw');
      expect(result.code.fallback).toBe('capacity');
      expect(result.code.matrix.ecc).toBe('L');
      expect(decodeScene(result.code.scene)).toBe(text);
    }
  });

  it('says too-long when it fits at no level, in both styles', () => {
    const text = 'a'.repeat(3500);
    expect(buildQr(text, { style: 'stuffcloud', ecc: 'L' })).toEqual({
      ok: false,
      error: 'too-long',
    });
    expect(buildQr(text, { style: 'raw', ecc: 'L' })).toEqual({ ok: false, error: 'too-long' });
    expect(buildQr('a'.repeat(MAX_TEXT_LENGTH + 1), { style: 'raw', ecc: 'L' })).toEqual({
      ok: false,
      error: 'too-long',
    });
  });

  it('reports scan-failed when even the raw picture does not scan, and offers nothing', () => {
    expect(buildQr('x', { style: 'raw', ecc: 'H' }, never)).toEqual({
      ok: false,
      error: 'scan-failed',
    });
    expect(buildQr('x', { style: 'stuffcloud', ecc: 'H' }, never)).toEqual({
      ok: false,
      error: 'scan-failed',
    });
  });

  it('runs the real scan test by default, on the picture it returns', () => {
    const result = buildQr('real scan', { style: 'stuffcloud', ecc: 'Q' });
    expect(result.ok && scanTest(result.code.scene, 'real scan')).toBe(true);
  });
});
