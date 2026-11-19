/**
 * Slugs: text that is safe in a URL or a file name. Every line becomes one slug.
 */

export type SlugSeparator = '-' | '_';

export interface SlugOptions {
  readonly separator: SlugSeparator;
  /** Keep only a-z and 0-9: letters of other scripts are dropped after accents are taken off. */
  readonly asciiOnly: boolean;
  /** Write ä, ö and ü as ae, oe and ue (German spelling) instead of a, o and u. */
  readonly germanUmlauts: boolean;
}

/** Letters that have no accent to take off but a standard transliteration. */
const LETTERS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
  ħ: 'h',
};

const UMLAUTS: Readonly<Record<string, string>> = { ä: 'ae', ö: 'oe', ü: 'ue' };

function transliterate(line: string, germanUmlauts: boolean): string {
  let out = '';
  for (const character of line.toLowerCase()) {
    const umlaut = germanUmlauts ? UMLAUTS[character] : undefined;
    out += umlaut ?? LETTERS[character] ?? character;
  }
  // Decompose, then take the accents off Latin letters only (marks of other scripts are part of them).
  return out
    .normalize('NFKD')
    .replace(/(?<=\p{Script=Latin})\p{M}+/gu, '')
    .normalize('NFC');
}

function slugLine(line: string, options: SlugOptions): string {
  const text = transliterate(line, options.germanUmlauts);
  const keep = options.asciiOnly ? /[a-z0-9]+/g : /[\p{L}\p{M}\p{N}]+/gu;
  return (text.match(keep) ?? []).join(options.separator);
}

export function slugify(text: string, options: SlugOptions): string {
  return text
    .split(/\r?\n/)
    .map((line) => slugLine(line, options))
    .join('\n');
}
