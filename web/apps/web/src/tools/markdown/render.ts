import DOMPurify from 'dompurify';
import { markdownToHtml } from './parse.ts';

/**
 * Markdown to safe HTML, for the preview and for copying.
 *
 * `marked` turns the Markdown into HTML (GitHub flavoured: tables, task lists, strikethrough,
 * autolinks) and passes raw HTML through; DOMPurify then cleans the result with a short list of
 * allowed tags and attributes. Nothing else is trusted:
 * - no `script`, `style`, `iframe`, `object`, `embed`, `form`, `svg`, `math`, `base`, `meta`, `link`;
 * - no event handler, no `style`, `class`, `id` or `name` attribute (so no CSS loads and no DOM clobbering);
 * - a link keeps its `href` only for `http:`, `https:` and `mailto:` (no `javascript:`, no `data:`, no relative link);
 * - an image keeps its `src` only for `http(s):` or an inline raster `data:` picture.
 *
 * The preview then goes one step further than the sanitiser: it never loads a picture from the
 * internet (see {@link toPreview}), so previewing a document never contacts a server.
 */

export const MAX_MARKDOWN_CHARS = 1_000_000;

const ALLOWED_TAGS = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'input',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'var',
];

const ALLOWED_ATTRIBUTES = [
  'href',
  'title',
  'alt',
  'src',
  'align',
  'colspan',
  'rowspan',
  'start',
  'type',
  'checked',
  'disabled',
  'open',
  'lang',
  'dir',
];

/** The tags and attributes that survive; the tests check every sanitised result against them. */
export const ALLOWED = { tags: ALLOWED_TAGS, attributes: ALLOWED_ATTRIBUTES } as const;

const LINK_PROTOCOLS = /^(?:https?:|mailto:)/i;
const INLINE_PICTURE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[A-Za-z0-9+/]*={0,2}$/i;

let purifier: ReturnType<typeof DOMPurify> | undefined;

/** The one sanitiser, set up on first use (it needs the page's `window`). */
function sanitiser(): ReturnType<typeof DOMPurify> {
  if (purifier !== undefined) {
    return purifier;
  }
  const instance = DOMPurify(window);
  instance.addHook('afterSanitizeAttributes', (node) => {
    const name = node.nodeName.toLowerCase();
    if (name === 'a') {
      // DOMPurify lets a relative or fragment link through; here only a link to the internet or to a mail address stays.
      const address = node.getAttribute('href');
      // Stryker disable next-line ConditionalExpression,BlockStatement: without `href` the test below reads the text "null", which is no link either, and removing an attribute that is not there changes nothing
      if (address === null) {
        return;
      }
      if (!LINK_PROTOCOLS.test(address)) {
        node.removeAttribute('href');
      }
    } else if (name === 'img') {
      const source = node.getAttribute('src');
      if (
        source !== null &&
        !(source.startsWith('data:') ? INLINE_PICTURE.test(source) : LINK_PROTOCOLS.test(source))
      ) {
        node.removeAttribute('src');
      }
    } else if (name === 'input') {
      // Only the checkbox of a task list; it cannot be changed.
      if (node.getAttribute('type')?.toLowerCase() === 'checkbox') {
        node.setAttribute('disabled', '');
      } else {
        node.remove();
      }
    }
  });
  purifier = instance;
  return instance;
}

/** Cleans HTML (what `marked` made of the text) down to what is allowed. */
export function sanitiseHtml(html: string): string {
  return sanitiser().sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRIBUTES,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    KEEP_CONTENT: true,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    RETURN_TRUSTED_TYPE: false,
  });
}

/** The sanitised HTML of a Markdown text (what "copy as HTML" puts on the clipboard). */
export function renderMarkdown(source: string): string {
  return sanitiseHtml(markdownToHtml(source));
}

// -- the preview ---------------------------------------------------------------------------

export interface PreviewLabels {
  /** Text in place of a picture that is not loaded; `alt` is the picture's own description. */
  readonly blockedImage: (alt: string) => string;
  readonly taskDone: string;
  readonly taskOpen: string;
}

export interface Preview {
  /** Nodes of the live document, ready to be put into the page. */
  readonly nodes: readonly Node[];
  /** Pictures from the internet that were replaced by their description. */
  readonly blockedImages: number;
}

/** The level each heading gets so that the outline never skips one: the first is 3, later ones at most one deeper than before, never past 6. */
export function previewLevels(levels: readonly number[], first = 3): number[] {
  let previous = first - 1;
  return levels.map((level) => {
    const next = Math.min(Math.max(level + first - 1, first), previous + 1, 6);
    previous = next;
    return next;
  });
}

/**
 * Turns sanitised HTML into nodes for the page. The HTML is parsed in an inert document (nothing
 * in it loads or runs there); a picture that is not an inline `data:` one is replaced by its
 * description before anything reaches the page, links open in a new tab without a referrer, and
 * the headings are moved below the tool's own so that the page outline stays in order.
 */
export function toPreview(html: string, labels: PreviewLabels): Preview {
  const inert = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  let blockedImages = 0;
  for (const image of inert.body.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? '';
    if (INLINE_PICTURE.test(source)) {
      continue;
    }
    if (source !== '') {
      blockedImages += 1;
    }
    const placeholder = inert.createElement('span');
    placeholder.className = 'blocked-image';
    placeholder.textContent = labels.blockedImage(image.getAttribute('alt') ?? '');
    image.replaceWith(placeholder);
  }
  for (const link of inert.body.querySelectorAll('a[href]')) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  for (const box of inert.body.querySelectorAll('input')) {
    box.setAttribute('aria-label', box.hasAttribute('checked') ? labels.taskDone : labels.taskOpen);
  }
  const headings = [...inert.body.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  const levels = previewLevels(headings.map((heading) => Number(heading.nodeName.slice(1))));
  headings.forEach((heading, index) => {
    const replacement = inert.createElement(`h${String(levels[index] ?? 6)}`);
    replacement.append(...heading.childNodes);
    heading.replaceWith(replacement);
  });
  const nodes = [...inert.body.childNodes].map((node) => document.importNode(node, true));
  return { nodes, blockedImages };
}
