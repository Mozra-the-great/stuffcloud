import { mountCanvas } from './canvas.ts';
import { mountSheet } from './css-sprite.ts';
import { mountImages } from './css-transform.ts';
import type { MountedVariant, VariantContext, VariantName } from './types.ts';

export * from './types.ts';

/** Starts one variant; the promise resolves once its art is loaded and it is running. */
export async function mountVariant(
  name: VariantName,
  context: VariantContext,
): Promise<MountedVariant> {
  switch (name) {
    case 'static':
      return mountImages(context, false);
    case 'css-transform':
      return mountImages(context, true);
    case 'css-sprite':
      return mountSheet(context, 'background');
    case 'css-strip':
      return mountSheet(context, 'strip');
    case 'canvas-raf':
      return mountCanvas(context, 'raf');
    case 'canvas-timer':
      return mountCanvas(context, 'timer');
  }
}
