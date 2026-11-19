import { inflateSync } from 'node:zlib';
import jsQR from 'jsqr';

/**
 * Decodes the QR code in a PNG file the app made: an 8-bit palette PNG without interlace. This is the
 * reader of the end-to-end tests, written here so that the file is checked the way any reader would
 * take it (zlib, palette, `jsQR`), not through the app's own code.
 */
export function decodeQrPng(file: Buffer): {
  width: number;
  height: number;
  text: string | undefined;
} {
  if (file.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a PNG file');
  }
  let width = 0;
  let height = 0;
  let palette = Buffer.alloc(0);
  const parts: Buffer[] = [];
  let offset = 8;
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('latin1', offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 3 || body[12] !== 0) {
        throw new Error('expected an 8-bit palette PNG without interlace');
      }
    } else if (type === 'PLTE') {
      palette = Buffer.from(body);
    } else if (type === 'IDAT') {
      parts.push(Buffer.from(body));
    }
    offset += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(parts));
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    if (rows[y * (width + 1)] !== 0) {
      throw new Error('expected the filter type "none"');
    }
    for (let x = 0; x < width; x += 1) {
      const index = rows[y * (width + 1) + 1 + x] ?? 0;
      const at = (y * width + x) * 4;
      rgba[at] = palette[index * 3] ?? 0;
      rgba[at + 1] = palette[index * 3 + 1] ?? 0;
      rgba[at + 2] = palette[index * 3 + 2] ?? 0;
      rgba[at + 3] = 255;
    }
  }
  return { width, height, text: jsQR(rgba, width, height)?.data };
}
