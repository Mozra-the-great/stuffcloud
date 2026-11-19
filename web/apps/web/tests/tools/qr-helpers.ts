import { crc32, inflateSync } from 'node:zlib';
import { expect } from 'vitest';
import type { Raster } from '../../src/tools/qr/render.ts';

/** Reads a PNG back the way any decoder would, with Node's zlib and CRC. */
export function readPng(file: Uint8Array): Raster {
  expect([...file.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let palette: [number, number, number][] = [];
  const data: Buffer[] = [];
  const types: string[] = [];
  while (offset < file.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...file.subarray(offset + 4, offset + 8));
    const body = file.subarray(offset + 8, offset + 8 + length);
    expect(view.getUint32(offset + 8 + length), `CRC of ${type}`).toBe(
      crc32(file.subarray(offset + 4, offset + 8 + length)),
    );
    types.push(type);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      expect([...body.subarray(8)]).toEqual([8, 3, 0, 0, 0]);
    } else if (type === 'PLTE') {
      palette = Array.from({ length: length / 3 }, (_, index) => [
        body[index * 3] ?? 0,
        body[index * 3 + 1] ?? 0,
        body[index * 3 + 2] ?? 0,
      ]);
    } else if (type === 'IDAT') {
      data.push(Buffer.from(body));
    }
    offset += 12 + length;
  }
  expect(types).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
  const rows = inflateSync(Buffer.concat(data));
  expect(rows.length).toBe(height * (width + 1));
  const pixels = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    expect(rows[row * (width + 1)]).toBe(0);
    pixels.set(rows.subarray(row * (width + 1) + 1, (row + 1) * (width + 1)), row * width);
  }
  return { width, height, palette, pixels };
}
