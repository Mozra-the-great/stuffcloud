/**
 * A small PNG writer for the QR picture: 8-bit palette colour (the picture has a handful of
 * colours), no filter, deflate through the browser's `CompressionStream`. The result is deterministic,
 * so a test can read the file back and decode the code in it.
 */

import type { Raster } from './render.ts';

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_, start) => {
  let value = start;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

/** CRC-32 as PNG uses it (the same as zlib's). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) {
    out[4 + index] = type.charCodeAt(index);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib-wrapped deflate of `bytes`. */
async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const packed = source.pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(packed).arrayBuffer());
}

export async function encodePng(raster: Raster): Promise<Uint8Array<ArrayBuffer>> {
  const { width, height, palette, pixels } = raster;
  if (palette.length < 1 || palette.length > 256) {
    throw new RangeError(`a PNG palette has 1 to 256 colours, got ${String(palette.length)}`);
  }
  if (pixels.length !== width * height) {
    throw new RangeError('the pixels do not fill the picture');
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  // 8 bits per pixel, colour type 3 (palette), deflate, adaptive filtering, no interlace.
  header.set([8, 3, 0, 0, 0], 8);

  const colors = new Uint8Array(palette.length * 3);
  for (const [index, [red, green, blue]] of palette.entries()) {
    colors.set([red, green, blue], index * 3);
  }

  // Every row starts with its filter type, 0 (none).
  const rows = new Uint8Array(height * (width + 1));
  for (let row = 0; row < height; row += 1) {
    rows.set(pixels.subarray(row * width, (row + 1) * width), row * (width + 1) + 1);
  }

  const parts = [
    SIGNATURE,
    chunk('IHDR', header),
    chunk('PLTE', colors),
    chunk('IDAT', await deflate(rows)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
