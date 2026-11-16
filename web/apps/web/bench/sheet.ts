/**
 * Builds the two-frame sprite sheet of the `css-sprite` variant from one mascot SVG, so the
 * benchmark needs no art that is not in `docs/design`. Frame 0 is the rest pose, frame 1 the
 * raised pose; every frame has one art row of headroom on top.
 */

export interface SpriteSheet {
  /** SVG source of the sheet: two frames stacked vertically. */
  readonly svg: string;
  /** Height of one frame in art pixels. */
  readonly frameRows: number;
}

const SVG_WRAPPER = /^\s*<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/;

/** Content between the outer `<svg>` tags; throws when `svg` is not a single SVG document. */
export function svgInner(svg: string): string {
  const match = SVG_WRAPPER.exec(svg);
  const inner = match?.[1];
  if (inner === undefined) {
    throw new Error('not an SVG document');
  }
  return inner;
}

/**
 * @param bobArtPixels how far the raised pose sits above the rest pose, in art pixels
 *   (BOB offset in CSS pixels divided by the scale).
 */
export function buildSpriteSheet(
  svg: string,
  cols: number,
  rows: number,
  bobArtPixels: number,
): SpriteSheet {
  const inner = svgInner(svg);
  const frameRows = rows + 1;
  const rest = 1;
  const raised = 1 - bobArtPixels;
  const sheet =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(cols)} ${String(frameRows * 2)}" ` +
    `shape-rendering="crispEdges">` +
    `<g transform="translate(0 ${String(rest)})">${inner}</g>` +
    `<g transform="translate(0 ${String(frameRows + raised)})">${inner}</g>` +
    `</svg>`;
  return { svg: sheet, frameRows };
}
