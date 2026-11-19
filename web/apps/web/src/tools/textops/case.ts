/**
 * Case conversion. Every line is converted on its own, so a list of names stays a list. Nothing here
 * depends on the visitor's locale: the same text gives the same result everywhere.
 */

export type CaseStyle =
  'upper' | 'lower' | 'title' | 'sentence' | 'camel' | 'pascal' | 'snake' | 'kebab' | 'constant';

export const CASE_STYLES: readonly CaseStyle[] = [
  'upper',
  'lower',
  'title',
  'sentence',
  'camel',
  'pascal',
  'snake',
  'kebab',
  'constant',
];

/** A letter and the marks that belong to it, or a run of digits: what a "word" is for identifiers. */
const WORD = /\p{Lu}+(?![\p{Ll}\p{M}])|\p{Lu}?[\p{Ll}\p{Lo}\p{Lm}\p{M}]+|\p{Lu}|\p{N}+/gu;

/** The words of an identifier-like text: `fooBar-baz_QUX1` gives foo, Bar, baz, QUX, 1. */
export function wordsOf(line: string): string[] {
  return line.match(WORD) ?? [];
}

function capitalise(word: string): string {
  const [first = '', ...rest] = word;
  return first.toUpperCase() + rest.join('').toLowerCase();
}

/** Capitalises the first letter of every word (letters, with `'` and `’` inside a word). */
function titleCase(line: string): string {
  return line
    .toLowerCase()
    .replace(
      /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu,
      (word) => word.charAt(0).toUpperCase() + word.slice(1),
    );
}

/** The first letter of the line and of each sentence is a capital, the rest is lowercase. */
function sentenceCase(line: string): string {
  return line
    .toLowerCase()
    .replace(
      /(^|[.!?…]\s+)(\p{L})/gu,
      (_, lead: string, letter: string) => lead + letter.toUpperCase(),
    )
    .replace(/^(\P{L}*)(\p{L})/u, (_, lead: string, letter: string) => lead + letter.toUpperCase());
}

function convertLine(line: string, style: CaseStyle): string {
  switch (style) {
    case 'upper':
      return line.toUpperCase();
    case 'lower':
      return line.toLowerCase();
    case 'title':
      return titleCase(line);
    case 'sentence':
      return sentenceCase(line);
    case 'camel': {
      const words = wordsOf(line).map(capitalise);
      const [first = '', ...rest] = words;
      return first.toLowerCase() + rest.join('');
    }
    case 'pascal':
      return wordsOf(line).map(capitalise).join('');
    case 'snake':
      return wordsOf(line)
        .map((word) => word.toLowerCase())
        .join('_');
    case 'kebab':
      return wordsOf(line)
        .map((word) => word.toLowerCase())
        .join('-');
    case 'constant':
      return wordsOf(line)
        .map((word) => word.toUpperCase())
        .join('_');
  }
}

export function convertCase(text: string, style: CaseStyle): string {
  return text
    .split('\n')
    .map((line) => {
      // A carriage return stays where it was: it is not a letter and not part of a word.
      const cr = line.endsWith('\r');
      const body = cr ? line.slice(0, -1) : line;
      return convertLine(body, style) + (cr ? '\r' : '');
    })
    .join('\n');
}
