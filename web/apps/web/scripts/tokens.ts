/**
 * Design tokens: the single source is the `:root` rule of `docs/design/prototypes/stuff.css`
 * (the same tokens the token table in `docs/design/README.md` lists). `src/styles/tokens.css`
 * is generated from it; `pnpm tokens` rewrites it and `pnpm tokens:check` (and a unit test,
 * so `pnpm test` covers it in CI) fails while it is stale. Never edit the generated file.
 */

export interface Token {
  /** Custom property name including the leading dashes, e.g. `--bg`. */
  readonly name: string;
  /** Value as written in the design source, whitespace-normalised. */
  readonly value: string;
}

export const SOURCE_PATH = 'docs/design/prototypes/stuff.css';

const NAME_PATTERN = /^--[a-z][a-z0-9-]*$/;

/** Splits on `separator` outside quotes and parentheses. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Normalises a value: single spaces, `, ` between top-level list items. */
function normaliseValue(raw: string): string {
  return splitTopLevel(raw, ',')
    .map((item) => item.trim().replace(/\s+/g, ' '))
    .join(', ');
}

/** Reads the custom properties of the first `:root` rule; throws when there are none. */
export function parseRootTokens(css: string): Token[] {
  const match = /:root\s*\{([^}]*)\}/.exec(stripComments(css));
  if (match?.[1] === undefined) {
    throw new Error('no :root rule found in the design stylesheet');
  }
  const tokens: Token[] = [];
  const seen = new Set<string>();
  for (const declaration of splitTopLevel(match[1], ';')) {
    if (declaration.trim() === '') {
      continue;
    }
    const colon = declaration.indexOf(':');
    const name = declaration.slice(0, Math.max(colon, 0)).trim();
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`:root declaration is not a custom property: ${declaration.trim()}`);
    }
    const value = normaliseValue(declaration.slice(colon + 1));
    if (value === '') {
      throw new Error(`token ${name} has an empty value`);
    }
    if (seen.has(name)) {
      throw new Error(`token ${name} is defined twice`);
    }
    seen.add(name);
    tokens.push({ name, value });
  }
  if (tokens.length === 0) {
    throw new Error(':root rule has no tokens');
  }
  return tokens;
}

/** Renders the generated stylesheet (Prettier-stable, ends with a newline). */
export function renderTokensCss(tokens: readonly Token[]): string {
  const lines = tokens.map((token) => `  ${token.name}: ${token.value};`);
  return [
    '/*',
    ' * GENERATED from the :root rule of ' + SOURCE_PATH + '.',
    ' * Do not edit: change the design source, then run `pnpm tokens` in web/.',
    ' */',
    ':root {',
    ...lines,
    '}',
    '',
  ].join('\n');
}

/** The full pipeline: design stylesheet text in, generated stylesheet text out. */
export function generateTokensCss(designCss: string): string {
  return renderTokensCss(parseRootTokens(designCss));
}

export interface TokenIo {
  readonly readSource: () => string;
  readonly readGenerated: () => string | undefined;
  readonly writeGenerated: (content: string) => void;
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
}

/** CLI logic: `--write` regenerates, `--check` (default) fails when the file is stale. Returns the exit code. */
export function runTokensCli(args: readonly string[], io: TokenIo): number {
  const mode = args[0] ?? '--check';
  if (mode !== '--write' && mode !== '--check') {
    io.err(`unknown argument ${mode}; use --write or --check`);
    return 2;
  }
  let expected: string;
  try {
    expected = generateTokensCss(io.readSource());
  } catch (error: unknown) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (mode === '--write') {
    io.writeGenerated(expected);
    io.out('tokens.css written');
    return 0;
  }
  if (io.readGenerated() === expected) {
    io.out('tokens.css is current');
    return 0;
  }
  io.err('tokens.css is stale: run `pnpm tokens` in web/ and commit the result');
  return 1;
}
