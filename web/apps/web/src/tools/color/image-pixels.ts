import type { Pixels } from './palette.ts';

/** The longer side of the working copy of an image: a palette does not need more. */
export const MAX_SIDE = 96;

/** Larger files are refused before they are decoded. */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

export type ImageErrorCode = 'too-large' | 'unreadable';

export class ImageError extends Error {
  readonly code: ImageErrorCode;

  constructor(code: ImageErrorCode) {
    super(code);
    this.name = 'ImageError';
    this.code = code;
  }
}

/** The size of the working copy: the longer side is `MAX_SIDE` at most, the ratio is kept. */
export function scaledSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Decodes an image file in the browser and returns the pixels of a small copy. Nothing is sent
 * anywhere: the file is decoded by `createImageBitmap` and drawn on an off-screen canvas.
 */
export async function readPixels(file: Blob): Promise<Pixels> {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ImageError('too-large');
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageError('unreadable');
  }
  try {
    const { width, height } = scaledSize(bitmap.width, bitmap.height);
    const context = new OffscreenCanvas(width, height).getContext('2d', {
      willReadFrequently: true,
    });
    if (context === null) {
      throw new ImageError('unreadable');
    }
    context.drawImage(bitmap, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    return { data, width, height };
  } finally {
    bitmap.close();
  }
}
