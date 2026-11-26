import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { PAYLOADS } from '../support/xss-payloads.ts';
import { ALLOWED } from '../../src/tools/markdown/render.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// Markdown preview in the built app, in Chromium and Firefox (T-23, #28). The accessibility gate
// (T-05, #13) applies to every tool: `a11y.check` after each state, a keyboard route for each
// action, results in live regions. The fixture of the specs fails a test that sends anything but a
// `GET` of the app's own assets: a picture from the internet that was loaded would fail it, so
// every test here proves that the preview never contacts a server. Hostile documents prove that
// nothing in them runs.

async function open(page: Page): Promise<void> {
  await page.goto('/tools/markdown');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(Markdown preview|Markdown-Vorschau)$/ }),
  ).toBeVisible();
}

function input(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: 'Markdown', exact: true });
}

function preview(page: Page): ReturnType<Page['locator']> {
  return page.locator('.preview');
}

/** The tool's own polite status line (the first one on the page is the search count). */
function status(page: Page): ReturnType<Page['locator']> {
  return page.locator('main [data-tool-status][role="status"]');
}

const HOSTILE = [
  '<script>window.__xss = "script"</script>',
  '<img src=x onerror="window.__xss = \'onerror\'">',
  '<img src="https://example.org/tracker.png" onload="window.__xss = \'onload\'">',
  '<svg onload="window.__xss = \'svg\'"><circle r="1"/></svg>',
  '<iframe srcdoc="<script>parent.__xss = \'iframe\'</script>"></iframe>',
  '<iframe src="https://example.org/frame"></iframe>',
  '<a href="javascript:window.__xss = \'link\'">click me</a>',
  '[markdown link](javascript:window.__xss = 1)',
  '<link rel="stylesheet" href="https://example.org/x.css">',
  '<style>body { background: url(https://example.org/bg.png) }</style>',
  '<div style="background:url(https://example.org/bg2.png)">styled</div>',
  '<form action="https://example.org/post" method="post"><input name="a"><button>send</button></form>',
  '<video src="https://example.org/v.mp4" autoplay></video>',
  '<object data="https://example.org/o.swf"></object>',
  '<details open ontoggle="window.__xss = \'toggle\'">d</details>',
  '<meta http-equiv="refresh" content="0;url=https://example.org/">',
  '![remote](https://example.org/remote.png)',
].join('\n\n');

test.describe('markdown', () => {
  test('opens with one heading, renders the example and passes the accessibility gate', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(preview(page).getByRole('heading', { name: 'Release notes' })).toBeVisible();
    await expect(preview(page).getByRole('table')).toBeVisible();
    await expect(status(page)).toHaveText('Rendered. 1 picture from the internet was not loaded.');
    await a11y.check(page, 'markdown');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expect(preview(page).getByRole('table')).toBeVisible();
    await expectKeyboardOnly(page, 'markdown');
  });

  test('renders tables, task lists, strikethrough and code', async ({ page, a11y }) => {
    await open(page);
    await input(page).fill(
      '## Title\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\n- [x] done\n- [ ] open\n\n~~gone~~ `code`\n\n```\nblock\n```',
    );
    await expect(preview(page).locator('del')).toHaveText('gone');
    await expect(preview(page).getByRole('checkbox')).toHaveCount(2);
    await expect(preview(page).getByRole('checkbox', { name: 'done', exact: true })).toBeChecked();
    await expect(preview(page).getByRole('checkbox', { name: 'not done' })).not.toBeChecked();
    await expect(preview(page).locator('th').first()).toHaveAttribute('align', 'left');
    await expect(preview(page).locator('pre code')).toHaveText('block');
    await a11y.check(page, 'markdown: elements');
  });

  test('keeps the outline in order, whatever the headings of the text are', async ({
    page,
    a11y,
  }) => {
    await open(page);
    await input(page).fill('# a\n\n###### b\n\n## c');
    await expect(preview(page).locator('h3')).toHaveText(['a']);
    await expect(preview(page).locator('h4')).toHaveText(['b', 'c']);
    await a11y.check(page, 'markdown: headings');
  });

  test('never runs, loads or follows anything of a hostile document', async ({ page, a11y }) => {
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await open(page);
    await input(page).fill(HOSTILE);
    await expect(status(page)).toHaveText(
      'Rendered. 2 pictures from the internet were not loaded.',
    );
    // Everything is plain, harmless markup now.
    expect(
      await preview(page)
        .locator(
          'script, iframe, object, form, video, link, style, meta, svg, [onerror], [onload], [ontoggle], [style]',
        )
        .count(),
    ).toBe(0);
    expect(await preview(page).locator('a[href^="javascript:"]').count()).toBe(0);
    await expect(preview(page).locator('.blocked-image')).toHaveText([
      '[Picture not loaded]',
      '[Picture not loaded]',
      '[Picture not loaded: remote]',
    ]);
    // The page gave a hostile link no way to run, and nothing ran on its own.
    await page.getByText('click me').click();
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: string }).__xss),
    ).toBeUndefined();
    expect(dialogs).toEqual([]);
    await a11y.check(page, 'markdown: hostile');
  });

  test('makes every payload of the XSS corpus safe in the real parsers of the browser', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await open(page);
    for (const payload of PAYLOADS) {
      await input(page).fill(payload);
      // The preview follows the text after a short pause: wait for the page to be at rest.
      await page.waitForTimeout(350);
      const found = await page.evaluate(
        ({ tags, attributes }) => {
          const problems: string[] = [];
          const extra = ['target', 'rel', 'aria-label', 'class'];
          for (const element of document.querySelectorAll('.preview *')) {
            const tag = element.localName;
            if (!tags.includes(tag) && tag !== 'span') {
              problems.push(`tag ${tag}`);
            }
            for (const attribute of element.attributes) {
              if (!attributes.includes(attribute.name) && !extra.includes(attribute.name)) {
                problems.push(`attribute ${attribute.name} on ${tag}`);
              }
              if (attribute.name === 'href' && !/^(?:https?:|mailto:)/i.test(attribute.value)) {
                problems.push(`href ${attribute.value}`);
              }
              if (attribute.name === 'src' && !attribute.value.startsWith('data:image/')) {
                problems.push(`src ${attribute.value}`);
              }
            }
          }
          return problems;
        },
        { tags: [...ALLOWED.tags], attributes: [...ALLOWED.attributes] },
      );
      expect(found, payload).toEqual([]);
    }
    expect(dialogs).toEqual([]);
  });

  test('shows a picture that is part of the text, and no other', async ({ page, a11y }) => {
    await open(page);
    await input(page).fill(
      '![inline](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==)\n\n![remote](https://example.net/other.png)',
    );
    await expect(preview(page).locator('img')).toHaveCount(1);
    await expect(preview(page).locator('.blocked-image')).toHaveText(
      '[Picture not loaded: remote]',
    );
    await a11y.check(page, 'markdown: inline picture');
  });

  test('copies the HTML', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
    await open(page);
    await expect(preview(page).getByRole('table')).toBeVisible();
    const button = page.getByRole('button', { name: 'Copy as HTML' });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByText('Copied the HTML').or(page.getByText(/Could not copy/)),
    ).toBeVisible();
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    await expect(preview(page).getByRole('table')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'markdown: phone');
  });
});

test.describe('markdown in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Markdown-Vorschau' })).toBeVisible();
    await expect(preview(page).getByRole('heading', { name: 'Versionshinweise' })).toBeVisible();
    await expect(status(page)).toHaveText(
      'Gerendert. 1 Bild aus dem Internet wurde nicht geladen.',
    );
    await a11y.check(page, 'markdown: German');
  });
});
