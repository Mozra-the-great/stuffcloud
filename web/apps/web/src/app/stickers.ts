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
