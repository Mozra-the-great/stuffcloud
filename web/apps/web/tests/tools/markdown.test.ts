import { cleanup, fireEvent, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/markdown/manifest.ts';
import { runTask } from '../../src/tools/markdown/parse.ts';
import { MAX_MARKDOWN_CHARS } from '../../src/tools/markdown/render.ts';
import { openTool } from '../tool-helpers.ts';

type User = ReturnType<typeof userEvent.setup>;

const pool = vi.hoisted(() => ({
  behaviour: 'real',
  created: 0,
  terminated: 0,
  run: undefined as unknown as (input: unknown, options: unknown) => Promise<unknown>,
}));

vi.mock('../../src/tools/markdown/pool.ts', () => ({
  createPool: () => {
    pool.created += 1;
    return {
      run: (input: unknown, options: unknown) => pool.run(input, options),
      terminate: () => {
        pool.terminated += 1;
      },
    };
  },
}));

beforeEach(() => {
  vi.stubGlobal(
    'Worker',
    class FakeWorker {
      readonly terminate = vi.fn();
    },
  );
  pool.behaviour = 'real';
  pool.created = 0;
  pool.terminated = 0;
  pool.run = (input, options) => {
    const { signal } = options as { signal: AbortSignal };
    if (pool.behaviour === 'fail') {
      return Promise.reject(new Error('boom'));
    }
    if (pool.behaviour === 'hang') {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      });
    }
    return Promise.resolve(runTask(input as { source: string }));
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  i18n.setLocale('en');
});

function input(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Markdown' });
}

function preview(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.preview');
  if (element === null) {
    throw new Error('no preview');
  }
  return element;
}

function statuses(): string {
  return [...document.querySelectorAll('main .tool-status')]
    .map((region) => region.textContent.trim())
    .filter((line) => line !== '')
    .join('|');
}

async function write(user: User, value: string): Promise<void> {
  await user.clear(input());
  await user.click(input());
  await user.paste(value);
}

describe('markdown', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/markdown with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/markdown');
    expect(view.headings).toEqual(['Markdown preview']);
    expect(view.searchHits('readme')).toEqual(['markdown']);
    expect(view.searchHits('vorschau')).toEqual(['markdown']);
  });

  it('renders the example: text, a task list, a table, a quote, code and a link', async () => {
    await openTool(manifest);
    await waitFor(() => {
      expect(preview().querySelector('table')).not.toBeNull();
    });
    expect(
      [...preview().querySelectorAll('h3, h4')].map(
        (heading) => `${heading.nodeName} ${heading.textContent}`,
      ),
    ).toEqual(['H3 Release notes', 'H4 Checklist', 'H4 Table']);
    expect(preview().querySelector('strong')?.textContent).toBe('bold');
    expect(preview().querySelector('del')?.textContent).toBe('strikethrough');
    expect(
      [...preview().querySelectorAll('input')].map((box) => [
        box.getAttribute('aria-label'),
        box.checked,
        box.disabled,
      ]),
    ).toEqual([
      ['done', true, true],
      ['not done', false, true],
    ]);
    expect(preview().querySelectorAll('td')).toHaveLength(2);
    expect(preview().querySelector('blockquote')?.textContent.trim()).toBe('A quote.');
    expect(preview().querySelector('pre code')?.textContent).toContain('let total = 1 + 2;');
    const link = preview().querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.org/project');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('does not load the picture from the internet, shows its description, and says so', async () => {
    await openTool(manifest);
    await waitFor(() => {
      expect(preview().querySelector('.blocked-image')).not.toBeNull();
    });
    expect(preview().querySelector('img')).toBeNull();
    expect(preview().querySelector('.blocked-image')?.textContent).toBe(
      '[Picture not loaded: A picture from the internet]',
    );
    await waitFor(() => {
      expect(statuses()).toBe('Rendered. 1 picture from the internet was not loaded.');
    });
  });

  it('renders what is typed, and keeps nothing from scripts', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await write(
      user,
      '<script>alert(1)</script><img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) **safe**',
    );
    await waitFor(() => {
      expect(preview().querySelector('strong')?.textContent).toBe('safe');
    });
    expect(preview().querySelector('script')).toBeNull();
    expect(preview().querySelector('[onerror]')).toBeNull();
    expect(preview().querySelector('a')?.hasAttribute('href')).toBe(false);
    await waitFor(() => {
      expect(statuses()).toBe('Rendered.');
    });
  });

  it('shows a picture that is part of the text', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await write(user, '![dot](data:image/png;base64,iVBORw0KGgo=)');
    await waitFor(() => {
      expect(preview().querySelector('img')?.getAttribute('src')).toBe(
        'data:image/png;base64,iVBORw0KGgo=',
      );
    });
  });

  it('names a picture without a description as such', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await write(user, '![](https://example.net/a.png)');
    await waitFor(() => {
      expect(preview().querySelector('.blocked-image')?.textContent).toBe('[Picture not loaded]');
    });
  });

  it('copies the sanitised HTML, with the pictures kept for the copy', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await write(user, '# Hi\n\n![a cat](https://example.org/cat.png) <script>x</script>');
    await waitFor(() => {
      expect(preview().querySelector('.blocked-image')).not.toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Copy as HTML' }));
    expect(await navigator.clipboard.readText()).toBe(
      '<h1>Hi</h1>\n<p><img src="https://example.org/cat.png" alt="a cat"> </p>\n',
    );
  });

  it('refuses a text that is too long', async () => {
    await openTool(manifest);
    await waitFor(() => {
      expect(preview().querySelector('table')).not.toBeNull();
    });
    await fireEvent.input(input(), { target: { value: 'a'.repeat(MAX_MARKDOWN_CHARS + 1) } });
    await waitFor(() => {
      expect(statuses()).toBe('The text is longer than 1,000,000 characters.');
    });
    expect(preview().childNodes).toHaveLength(0);
  });

  it('says that the preview is safe', async () => {
    await openTool(manifest);
    expect(screen.getByText(/so previewing never contacts a server/)).toBeTruthy();
  });

  it('starts in German with the German example, and renders it', async () => {
    i18n.setLocale('de');
    await openTool(manifest);
    i18n.setLocale('de');
    await waitFor(() => {
      expect(preview().querySelector('h3')).not.toBeNull();
    });
    expect(screen.getByRole('textbox', { name: 'Markdown' })).toBeTruthy();
  });
});

describe('markdown: a text that cannot be rendered', () => {
  it('says so when the worker fails, and keeps the last good preview', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await waitFor(() => {
      expect(preview().querySelector('table')).not.toBeNull();
    });
    pool.behaviour = 'fail';
    await write(user, 'changed');
    await waitFor(() => {
      expect(statuses()).toBe('The text could not be rendered.');
    });
    expect(preview().querySelector('table')).not.toBeNull();
  });

  it('stops a text that takes too long, and renders the next one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    pool.behaviour = 'hang';
    await openTool(manifest);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(8500);
    await waitFor(() => {
      expect(statuses()).toBe('Stopped after 8 seconds: this text is too complex to render here.');
    });
    pool.behaviour = 'real';
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await write(user, '**fine**');
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => {
      expect(preview().querySelector('strong')?.textContent).toBe('fine');
    });
  });

  it('ends its worker when the page goes away', async () => {
    await openTool(manifest);
    await waitFor(() => {
      expect(preview().querySelector('table')).not.toBeNull();
    });
    cleanup();
    expect(pool.terminated).toBe(1);
  });
});
