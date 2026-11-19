/**
 * Counters for a text. Characters are what a reader sees as one (a family emoji is one, an `e` with
 * an accent is one), found with `Intl.Segmenter`; words follow the same rules for scripts without
 * spaces between words.
 */

export interface Counts {
  /** Characters as a reader counts them. */
  readonly characters: number;
  /** The same without spaces, tabs and line breaks. */
  readonly charactersWithoutSpaces: number;
  readonly words: number;
  /** Lines: a final line break does not add one, an empty text has none. */
  readonly lines: number;
  /** Blocks of text separated by at least one empty line. */
  readonly paragraphs: number;
  /** Size of the text as UTF-8. */
  readonly bytes: number;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const WORDS = new Intl.Segmenter(undefined, { granularity: 'word' });

export function countText(text: string): Counts {
  let characters = 0;
  let spaces = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    characters += 1;
    if (/^\s+$/u.test(segment)) {
      spaces += 1;
    }
  }
  let words = 0;
  for (const part of WORDS.segment(text)) {
    if (part.isWordLike === true) {
      words += 1;
    }
  }
  const lines = text === '' ? 0 : text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0);
  const paragraphs = text
    .split(/(?:\r?\n[ \t]*){2,}/)
    .filter((block) => block.trim() !== '').length;
  return {
    characters,
    charactersWithoutSpaces: characters - spaces,
    words,
    lines,
    paragraphs,
    bytes: new TextEncoder().encode(text).length,
  };
}
