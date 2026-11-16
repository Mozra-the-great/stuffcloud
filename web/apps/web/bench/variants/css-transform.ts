import type { MountedVariant, VariantContext } from './types.ts';

/**
 * One `<img>` per mascot. With `animated`, the CSS class `bench-bob` switches the two poses with
 * a `transform` keyframe animation and `steps(1)` (the shipped `Mascot.svelte` technique); without
 * it the image stays still, which is the control of the benchmark.
 */
export function mountImages(context: VariantContext, animated: boolean): MountedVariant {
  const { host, art, scale, count, env } = context;
  const cells: HTMLElement[] = [];
  for (let index = 0; index < count; index += 1) {
    const cell = env.document.createElement('span');
    cell.className = 'bench-cell';
    const image = env.document.createElement('img');
    image.src = art.url;
    image.alt = '';
    image.width = art.cols * scale;
    image.height = art.rows * scale;
    image.className = animated ? 'bench-art bench-bob' : 'bench-art';
    cell.append(image);
    host.append(cell);
    cells.push(cell);
  }
  return {
    stop: (): void => {
      for (const cell of cells) {
        cell.remove();
      }
    },
  };
}
