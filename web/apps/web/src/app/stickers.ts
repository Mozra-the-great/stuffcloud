import { isCodeArt, type CodeArt } from '@mozra-the-great/kern';
import type { StickerName } from '@stuffcloud/tools';

const SOURCE_DIR = '../../../../../docs/design/prototypes';

/** Vite resolves the glob at build time; each match is the hashed URL of the emitted file. */
const FILE_URLS: Readonly<Record<string, string>> = import.meta.glob<string>(
  '../../../../../docs/design/prototypes/sticker-*.svg',
  { query: '?url', import: 'default', eager: true },
);

/** URL of the emitted SVG of a design sticker; throws when the file is missing from the build. */
export function stickerUrl(
  name: StickerName,
  urls: Readonly<Record<string, string>> = FILE_URLS,
): string {
  const url = urls[`${SOURCE_DIR}/sticker-${name}.svg`];
  if (url === undefined) {
    throw new Error(`sticker art for ${name} is missing: sticker-${name}.svg`);
  }
  return url;
}

/** kern's code art of a design sticker (`tool-stickers/sticker-<name>`: its pixel grid); throws when kern has none. */
export function stickerArt(name: StickerName): CodeArt {
  const art = `tool-stickers/sticker-${name}`;
  if (!isCodeArt(art)) {
    throw new Error(`kern has no code art for the sticker ${name}`);
  }
  return art;
}

/**
 * The whole number of CSS pixels per art pixel that brings a sticker of `rows` art rows closest to
 * `height` CSS pixels, at least one: a sticker is crisp or not drawn at all, never stretched.
 */
export function stickerScale(height: number, rows: number): number {
  return Math.max(1, Math.round(height / rows));
}
