/**
 * The mascot cast and the rules for drawing it. The art is the first-party pixel art in
 * `docs/design/prototypes` (SVG, one frame per animal, generated from ASCII sources by
 * `docs/design/tools/mascots.py`); the app references those files directly, so there is one copy.
 * Runtime decision and measurements: `docs/adr/0008-pixel-art-animation-runtime.md`.
 */

export const MASCOT_NAMES = [
  'stuffy',
  'mochi',
  'hop',
  'bun',
  'bloop',
  'waddle',
  'ember',
  'boo',
  'cumulo',
] as const;

export type MascotName = (typeof MASCOT_NAMES)[number];

/** File (without `.svg`) in `docs/design/prototypes` and the pixel grid of each mascot. */
interface MascotSource {
  readonly file: string;
  readonly animal: string;
  readonly cols: number;
  readonly rows: number;
}

export const MASCOT_SOURCES: Readonly<Record<MascotName, MascotSource>> = {
  stuffy: { file: 'axo', animal: 'axolotl', cols: 16, rows: 11 },
  mochi: { file: 'mascot-cat', animal: 'cat', cols: 14, rows: 12 },
  hop: { file: 'mascot-frog', animal: 'frog', cols: 14, rows: 10 },
  bun: { file: 'mascot-bunny', animal: 'bunny', cols: 12, rows: 12 },
  bloop: { file: 'mascot-jelly', animal: 'jellyfish', cols: 12, rows: 11 },
  waddle: { file: 'mascot-penguin', animal: 'penguin', cols: 12, rows: 11 },
  ember: { file: 'mascot-fox', animal: 'fox', cols: 14, rows: 10 },
  boo: { file: 'mascot-ghost', animal: 'ghost', cols: 12, rows: 11 },
  cumulo: { file: 'mascot-cloudy', animal: 'cloud', cols: 14, rows: 8 },
};

export interface MascotArt extends MascotSource {
  readonly name: MascotName;
  /** URL of the emitted SVG file (never inlined: the CSP allows images from the own origin only). */
  readonly url: string;
}

const SOURCE_DIR = '../../../../../docs/design/prototypes';

/** Vite resolves the glob at build time; each match is the hashed URL of the emitted file. */
const FILE_URLS: Readonly<Record<string, string>> = import.meta.glob<string>(
  '../../../../../docs/design/prototypes/{axo,mascot-*}.svg',
  { query: '?url', import: 'default', eager: true },
);

/** Joins the catalogue with the URLs of the emitted files; throws when a file is missing. */
export function resolveMascots(
  urls: Readonly<Record<string, string>>,
): Readonly<Record<MascotName, MascotArt>> {
  const entries = MASCOT_NAMES.map((name): [MascotName, MascotArt] => {
    const source = MASCOT_SOURCES[name];
    const url = urls[`${SOURCE_DIR}/${source.file}.svg`];
    if (url === undefined) {
      throw new Error(`mascot art for ${name} is missing: ${source.file}.svg`);
    }
    return [name, { ...source, name, url }];
  });
  return Object.fromEntries(entries) as Record<MascotName, MascotArt>;
}

export const MASCOTS: Readonly<Record<MascotName, MascotArt>> = resolveMascots(FILE_URLS);

/**
 * A drawable integer scale: pixel art stays crisp only when every art pixel becomes a whole
 * number of CSS pixels. Fractions are cut off; anything below 1 or not finite becomes 1.
 */
export function normaliseScale(scale: number): number {
  return Number.isFinite(scale) && scale >= 1 ? Math.floor(scale) : 1;
}

/** The largest integer scale whose width does not exceed `targetWidth` (at least 1). */
export function integerScale(targetWidth: number, cols: number): number {
  return Number.isFinite(targetWidth) && cols > 0 ? normaliseScale(targetWidth / cols) : 1;
}

/** Drawn size in CSS pixels at an integer scale. */
export function mascotSize(
  art: Pick<MascotArt, 'cols' | 'rows'>,
  scale: number,
): { readonly width: number; readonly height: number } {
  const factor = normaliseScale(scale);
  return { width: art.cols * factor, height: art.rows * factor };
}
