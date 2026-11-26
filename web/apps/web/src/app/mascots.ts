/**
 * Where the mascot art is served from. The component and the cast (names, pixel grids, motion)
 * are kern's (`Mascot`, `MASCOT_SOURCES`, ADR 0014); the art stays the first-party pixel art in
 * `docs/design/prototypes` (SVG, one frame per animal, generated from ASCII sources by
 * `docs/design/tools/mascots.py`), referenced directly so there is one copy (ADR 0008).
 */
import { MASCOT_NAMES, MASCOT_SOURCES, type MascotName } from '@mozra-the-great/kern';

const SOURCE_DIR = '../../../../../docs/design/prototypes';

/** Vite resolves the glob at build time; each match is the hashed URL of the emitted file. */
const FILE_URLS: Readonly<Record<string, string>> = import.meta.glob<string>(
  '../../../../../docs/design/prototypes/{axo,mascot-*}.svg',
  { query: '?url', import: 'default', eager: true },
);

/**
 * The URL of each mascot's emitted SVG file (never inlined: the CSP allows images from the own
 * origin only). Throws when a file is missing.
 */
export function resolveMascotUrls(
  urls: Readonly<Record<string, string>>,
): Readonly<Record<MascotName, string>> {
  const entries = MASCOT_NAMES.map((name): [MascotName, string] => {
    const file = MASCOT_SOURCES[name].file;
    const url = urls[`${SOURCE_DIR}/${file}.svg`];
    if (url === undefined) {
      throw new Error(`mascot art for ${name} is missing: ${file}.svg`);
    }
    return [name, url];
  });
  return Object.fromEntries(entries) as Record<MascotName, string>;
}

/** Pass as `src` of kern's `Mascot`: `<Mascot name="stuffy" src={MASCOT_URLS.stuffy} />`. */
export const MASCOT_URLS: Readonly<Record<MascotName, string>> = resolveMascotUrls(FILE_URLS);
