import { crc32, deflateSync } from 'node:zlib';

export type Color = readonly [red: number, green: number, blue: number, alpha?: number];

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/**
 * A small PNG, made here so that no image has to be committed: `width` x `height` pixels, the pixel
 * at `(x, y)` has the colour `colorAt(x, y)`. Plain 8-bit RGBA, no colour profile, so a browser
 * decodes exactly these values.
 */
export function png(
  width: number,
  height: number,
  colorAt: (x: number, y: number) => Color,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue, alpha = 255] = colorAt(x, y);
      rows.set([red, green, blue, alpha], row + 1 + x * 4);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
