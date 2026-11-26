import { describe, expect, it } from 'vitest';
import {
  ALLOWED,
  renderMarkdown,
  sanitiseHtml,
  toPreview,
  type PreviewLabels,
} from '../../src/tools/markdown/render.ts';

/**
 * The policy of the Markdown sanitiser, written out a second time so that a change of the lists in
 * `render.ts` (a tag dropped, an attribute added) fails here and has to be decided on purpose.
 */
const TAGS = [
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

const ATTRIBUTES = [
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

const labels: PreviewLabels = {
  blockedImage: (alt) => (alt === '' ? '[picture not loaded]' : `[picture not loaded: ${alt}]`),
  taskDone: 'done',
  taskOpen: 'open',
};

function dom(html: string): HTMLElement {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
}

/** One document in which every allowed tag stands where it is valid. */
const EVERY_TAG = [
  '<a href="https://example.com/" title="t">a</a>',
  '<abbr>abbr</abbr><b>b</b><blockquote>q</blockquote>line<br>',
  '<code>c</code><del>d</del><details open><summary>s</summary>x</details><div>d</div>',
  '<dl><dt>t</dt><dd>d</dd></dl><em>e</em>',
  '<h1>1</h1><h2>2</h2><h3>3</h3><h4>4</h4><h5>5</h5><h6>6</h6><hr><i>i</i>',
  '<img src="https://example.com/a.png" alt="a"><input type="checkbox" checked disabled>',
  '<ins>i</ins><kbd>k</kbd><mark>m</mark><ol start="3" type="a"><li>l</li></ol><ul><li>l</li></ul>',
  '<p lang="de" dir="rtl">p</p><pre>pre</pre><q>q</q><s>s</s><samp>s</samp><small>s</small>',
  '<span>s</span><strong>s</strong><sub>s</sub><sup>s</sup>',
  '<table><caption>c</caption><thead><tr><th colspan="2" rowspan="3" align="left">h</th></tr></thead>',
  '<tbody><tr><td>d</td></tr></tbody><tfoot><tr><td>f</td></tr></tfoot></table>',
  '<u>u</u><var>v</var>',
].join('');

describe('the sanitiser policy', () => {
  it('allows exactly these tags and these attributes', () => {
    expect([...ALLOWED.tags]).toEqual(TAGS);
    expect([...ALLOWED.attributes]).toEqual(ATTRIBUTES);
  });

  it('keeps every allowed tag', () => {
    const body = dom(sanitiseHtml(EVERY_TAG));
    for (const tag of TAGS) {
      expect(body.querySelector(tag), `<${tag}>`).not.toBeNull();
    }
  });

  it.each([
    ['href', 'a', 'https://example.com/'],
    ['title', 'a', 'a title'],
    ['alt', 'img', 'a picture'],
    ['src', 'img', 'https://example.com/a.png'],
    ['align', 'th', 'left'],
    ['colspan', 'th', '2'],
    ['rowspan', 'th', '3'],
    ['start', 'ol', '3'],
    ['type', 'ol', 'a'],
    ['open', 'details', ''],
    ['lang', 'p', 'de'],
    ['dir', 'p', 'rtl'],
  ])('keeps the attribute %s of <%s>', (attribute, tag, value) => {
    const wrapped: Record<string, (inner: string) => string> = {
      th: (inner) => `<table><thead><tr>${inner}</tr></thead></table>`,
      ol: (inner) => inner,
      details: (inner) => inner,
    };
    const element = `<${tag} ${attribute}="${value}">x</${tag}>`;
    const html = (wrapped[tag] ?? ((inner: string): string => inner))(element);
    const found = dom(sanitiseHtml(html)).querySelector(tag);
    expect(found?.getAttribute(attribute), `${attribute} of <${tag}>`).toBe(value);
  });

  it('keeps the checkbox of a task list, checked or not, and always disabled', () => {
    const body = dom(
      sanitiseHtml('<input type="checkbox" checked disabled><input type="checkbox">'),
    );
    const boxes = [...body.querySelectorAll('input')];
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.hasAttribute('checked')).toBe(true);
    expect(boxes[1]?.hasAttribute('checked')).toBe(false);
    for (const box of boxes) {
      expect(box.getAttribute('disabled')).toBe('');
      expect(box.getAttribute('type')).toBe('checkbox');
    }
  });

  it.each([
    'script',
    'style',
    'iframe',
    'object',
    'embed',
    'form',
    'svg',
    'math',
    'base',
    'meta',
    'link',
    'textarea',
    'button',
    'select',
    'audio',
    'video',
    'canvas',
    'font',
    'center',
    'marquee',
  ])('removes <%s>', (tag) => {
    const body = dom(sanitiseHtml(`<${tag} src="https://example.com/x">x</${tag}>after`));
    expect(body.querySelector(tag)).toBeNull();
  });

  it.each([
    ['onclick', 'alert(1)'],
    ['onerror', 'alert(1)'],
    ['style', 'color:red'],
    ['class', 'big'],
    ['id', 'x'],
    ['name', 'x'],
    ['data-x', '1'],
    ['aria-label', 'x'],
    ['role', 'button'],
    ['tabindex', '0'],
    ['target', '_blank'],
    ['rel', 'opener'],
    ['formaction', 'https://example.com/'],
  ])('removes the attribute %s', (attribute, value) => {
    const body = dom(sanitiseHtml(`<p ${attribute}="${value}">x</p>`));
    expect(body.querySelector('p')?.attributes.length).toBe(0);
  });

  it('removes an unknown protocol from an attribute that holds no address', () => {
    // `start` and `colspan` are not addresses: a value that looks like a URL with a protocol is not a number.
    expect(sanitiseHtml('<ol start="foo:bar"><li>x</li></ol>')).toBe('<ol><li>x</li></ol>');
    expect(
      dom(sanitiseHtml('<table><tr><td colspan="x:y">c</td></tr></table>')).querySelector('td')
        ?.attributes.length,
    ).toBe(0);
  });

  it('gives a string back, never a node and never a trusted type', () => {
    expect(typeof sanitiseHtml('<p>x</p>')).toBe('string');
    expect(sanitiseHtml('<p>x</p>')).toBe('<p>x</p>');
    expect(sanitiseHtml('')).toBe('');
  });

  it('keeps the text of what it removes', () => {
    expect(sanitiseHtml('<form>keep <b>this</b></form>')).toBe('keep <b>this</b>');
  });
});

describe('links', () => {
  function href(address: string): string | null {
    return (
      dom(sanitiseHtml(`<a href="${address}">x</a>`))
        .querySelector('a')
        ?.getAttribute('href') ?? null
    );
  }

  it.each([
    'http://example.com/',
    'https://example.com/',
    'HTTP://EXAMPLE.COM/',
    'Https://example.com/a?b=c#d',
    'mailto:a@example.com',
    'MAILTO:a@example.com',
  ])('keeps %s', (address) => {
    expect(href(address)).toBe(address);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,x',
    'vbscript:x',
    'ftp://example.com/',
    'tel:+4912345',
    'sms:+4912345',
    'file:///etc/passwd',
    '#fragment',
    '/relative',
    'relative/path',
    '//example.com/',
    // A protocol in the middle is no protocol: nothing but the start of the address counts.
    'path/http://example.com/',
    'path/https://example.com/',
    'path/mailto:a@example.com',
    '?next=https://example.com/',
    '#https://example.com/',
  ])('removes the address %s but keeps the link text', (address) => {
    expect(sanitiseHtml(`<a href="${address}">text</a>`)).toBe('<a>text</a>');
  });

  it('leaves a link without an address alone', () => {
    expect(sanitiseHtml('<a>text</a>')).toBe('<a>text</a>');
    expect(sanitiseHtml('<a title="t">text</a>')).toBe('<a title="t">text</a>');
  });
});

describe('pictures', () => {
  function src(address: string): string | null {
    return (
      dom(sanitiseHtml(`<img src="${address}" alt="a">`))
        .querySelector('img')
        ?.getAttribute('src') ?? null
    );
  }

  it.each(['https://example.com/a.png', 'http://example.com/a.png', 'HTTPS://EXAMPLE.COM/A.PNG'])(
    'keeps the source %s for copying',
    (address) => {
      expect(src(address)).toBe(address);
    },
  );

  it.each([
    ['png', 'iVBORw0KGgo='],
    ['jpg', '/9j/4AAQ=='],
    ['jpeg', '/9j/4AAQ=='],
    ['gif', 'R0lGODlh'],
    ['webp', 'UklGRg=='],
    ['avif', 'AAAAHGZ0eXA='],
    ['bmp', 'Qk0='],
    ['PNG', 'AAAA'],
  ])('keeps an inline %s picture', (kind, payload) => {
    const address = `data:image/${kind};base64,${payload}`;
    expect(src(address)).toBe(address);
  });

  it('keeps an inline picture without or with one or two padding characters', () => {
    for (const payload of ['AAAA', 'AAA=', 'AA==', '']) {
      const address = `data:image/png;base64,${payload}`;
      expect(src(address), payload).toBe(address);
    }
  });

  it.each([
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/x-icon;base64,AAAA',
    'data:image/png,AAAA',
    'data:image/png;charset=utf-8;base64,AAAA',
    'data:image/png;base64,AAA===',
    'data:image/png;base64,AA=A',
    'data:image/png;base64,AAAA!',
    'data:image/png;base64,AA AA',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/jpegx;base64,AAAA',
    'data:image/pngg;base64,AAAA',
    'data:image;base64,AAAA',
    'data:,x',
    'javascript:alert(1)',
    'ftp://example.com/a.png',
    '/a.png',
    '//example.com/a.png',
    'relative.png',
    'a/https://example.com/a.png',
  ])('removes the source %s', (address) => {
    expect(src(address)).toBeNull();
  });

  it('leaves a picture without a source alone', () => {
    expect(sanitiseHtml('<img alt="a">')).toBe('<img alt="a">');
  });
});

describe('checkboxes and other inputs', () => {
  it('disables a checkbox that comes as raw HTML, whatever the case of its type', () => {
    for (const type of ['checkbox', 'CHECKBOX', 'CheckBox']) {
      const box = dom(sanitiseHtml(`<input type="${type}">`)).querySelector('input');
      expect(box?.getAttribute('disabled'), type).toBe('');
    }
  });

  it.each([
    '<input type="text">',
    '<input type="password">',
    '<input type="file">',
    '<input type="submit">',
    '<input type="hidden" value="x">',
    '<input>',
    '<p>a<input>b</p>',
    '<input type="">',
  ])('removes %s', (html) => {
    expect(dom(sanitiseHtml(html)).querySelector('input')).toBeNull();
  });

  it('removes an input that is not a checkbox but keeps the text around it', () => {
    expect(sanitiseHtml('<p>a<input type="text">b</p>')).toBe('<p>ab</p>');
  });
});

describe('Markdown through the sanitiser', () => {
  it('does not turn a line break into a <br> (breaks: false)', () => {
    expect(renderMarkdown('a\nb')).toBe('<p>a\nb</p>\n');
  });

  it('renders GitHub flavour: tables, strikethrough, task lists and autolinks', () => {
    expect(renderMarkdown('~~gone~~')).toBe('<p><del>gone</del></p>\n');
    expect(renderMarkdown('https://example.com/')).toContain('<a href="https://example.com/">');
    expect(renderMarkdown('| a |\n|---|\n| b |')).toContain('<table>');
    expect(renderMarkdown('- [x] done')).toContain('checked');
  });
});

describe('toPreview', () => {
  it('shows the description of a picture that has none', () => {
    const preview = toPreview('<img src="https://example.com/a.png">', labels);
    expect(preview.blockedImages).toBe(1);
    expect(preview.nodes.map((node) => node.textContent)).toEqual(['[picture not loaded]']);
  });

  it('shows the description of a picture that has one', () => {
    const preview = toPreview('<img src="https://example.com/a.png" alt="the logo">', labels);
    expect(preview.nodes.map((node) => node.textContent)).toEqual([
      '[picture not loaded: the logo]',
    ]);
  });

  it('loads a picture only when the whole source is an inline picture', () => {
    // The data: text is somewhere inside an address on the internet: it must not pass for a picture.
    const sneaky = 'https://example.com/?x=data:image/png;base64,AAAA';
    const preview = toPreview(`<img src="${sneaky}" alt="x">`, labels);
    expect(preview.blockedImages).toBe(1);
    expect(preview.nodes.map((node) => node.nodeName)).toEqual(['SPAN']);
    const kept = toPreview('<img src="data:image/png;base64,AAAA" alt="x">', labels);
    expect(kept.blockedImages).toBe(0);
    expect(kept.nodes.map((node) => node.nodeName)).toEqual(['IMG']);
    const trailing = toPreview('<img src="data:image/png;base64,AAAA!x" alt="x">', labels);
    expect(trailing.nodes.map((node) => node.nodeName)).toEqual(['SPAN']);
    const jpeg = toPreview('<img src="data:image/jpeg;base64,AAAA" alt="x">', labels);
    expect(jpeg.nodes.map((node) => node.nodeName)).toEqual(['IMG']);
    const padded = toPreview('<img src="data:image/png;base64,AA==" alt="x">', labels);
    expect(padded.nodes.map((node) => node.nodeName)).toEqual(['IMG']);
  });
});
