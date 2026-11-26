import { BOB_OFFSET_PX } from '@mozra-the-great/kern';
import { buildSpriteSheet } from '../sheet.ts';
import type { MountedVariant, VariantContext } from './types.ts';

export type SheetTechnique = 'background' | 'strip';

/**
 * Sprite-sheet animation with the two poses stacked in one image (built from the mascot SVG in
 * memory, because the delivered art has no sheets). Both techniques switch frames with
 * `steps(1)`:
 *
 * - `background`: one element, `background-position` animated (class `bench-sprite`). The
 *   classic technique; the browser repaints the element on the main thread at every change.
 * - `strip`: the sheet is an `<img>` inside a clipping box and its `transform` is animated
 *   (class `bench-strip`), which stays on the compositor and generalises to any frame count.
 */
export async function mountSheet(
  context: VariantContext,
  technique: SheetTechnique,
): Promise<MountedVariant> {
  const { host, art, scale, count, env } = context;
  const sheet = buildSpriteSheet(
    await env.fetchText(art.url),
    art.cols,
    art.rows,
    BOB_OFFSET_PX / scale,
  );
  const resource = env.objectUrl(sheet.svg);
  const width = art.cols * scale;
  const frameHeight = sheet.frameRows * scale;
  const cells: HTMLElement[] = [];
  for (let index = 0; index < count; index += 1) {
    const cell = env.document.createElement('span');
    cell.className = 'bench-cell';
    cell.append(
      technique === 'background'
        ? backgroundSprite(env.document, resource.url, width, frameHeight)
        : stripSprite(env.document, resource.url, width, frameHeight),
    );
    host.append(cell);
    cells.push(cell);
  }
  return {
    stop: (): void => {
      for (const cell of cells) {
        cell.remove();
      }
      resource.revoke();
    },
  };
}

function backgroundSprite(
  doc: Document,
  url: string,
  width: number,
  frameHeight: number,
): HTMLElement {
  const sprite = doc.createElement('span');
  sprite.className = 'bench-sprite';
  sprite.style.width = `${String(width)}px`;
  sprite.style.height = `${String(frameHeight)}px`;
  sprite.style.backgroundImage = `url("${url}")`;
  sprite.style.backgroundSize = `${String(width)}px ${String(frameHeight * 2)}px`;
  sprite.style.setProperty('--frame-h', `${String(frameHeight)}px`);
  return sprite;
}

function stripSprite(doc: Document, url: string, width: number, frameHeight: number): HTMLElement {
  const clip = doc.createElement('span');
  clip.className = 'bench-clip';
  clip.style.width = `${String(width)}px`;
  clip.style.height = `${String(frameHeight)}px`;
  const strip = doc.createElement('img');
  strip.className = 'bench-strip';
  strip.src = url;
  strip.alt = '';
  strip.width = width;
  strip.height = frameHeight * 2;
  strip.style.setProperty('--frame-h', `${String(frameHeight)}px`);
  clip.append(strip);
  return clip;
}
