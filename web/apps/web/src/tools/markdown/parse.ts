import { Marked } from 'marked';

/**
 * The first half of the Markdown pipeline: Markdown to HTML with `marked` (GitHub flavoured; raw HTML
 * passes through, unclean). It touches no DOM, so it runs in a worker: some texts take `marked` minutes
 * (long runs of `*a`), and a worker can be stopped where the page could only freeze.
 */
// Stryker disable next-line ObjectLiteral: the options are marked's own defaults, spelled out so that a change of its defaults cannot change the output; `breaks` and `async` are tested
const markdown = new Marked({ gfm: true, breaks: false, async: false });

export interface Input {
  readonly source: string;
}

export type Output = string;

export function isInput(value: unknown): value is Input {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly source?: unknown }).source === 'string'
  );
}

/** The (unclean) HTML of a Markdown text. */
export function markdownToHtml(source: string): string {
  // Stryker disable next-line ObjectLiteral: the instance is already `async: false`; the argument only picks the overload that returns a string
  return markdown.parse(source, { async: false });
}

/** The work of the tool in the worker. */
export function runTask(input: Input): Output {
  return markdownToHtml(input.source);
}
