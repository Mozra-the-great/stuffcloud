import type { ThumbBitmap } from './types.ts';

/**
 * Paints a page picture on `canvas`, turned clockwise by `turn` degrees (0, 90, 180 or 270): the
 * canvas gets the size of the turned picture, so the page shows how it will come out of the file.
 * Does nothing when the browser gives no 2D context or the bitmap was already released.
 */
export function drawThumb(canvas: HTMLCanvasElement, bitmap: ThumbBitmap, turn: number): void {
  const sideways = turn % 180 !== 0;
  const width = sideways ? bitmap.height : bitmap.width;
  const height = sideways ? bitmap.width : bitmap.height;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) {
    return;
  }
  context.save();
  context.translate(width / 2, height / 2);
  context.rotate((turn * Math.PI) / 180);
  try {
    context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  } catch {
    // A released bitmap cannot be drawn; the page keeps its empty frame.
  }
  context.restore();
}
