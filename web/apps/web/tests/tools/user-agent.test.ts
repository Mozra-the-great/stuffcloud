import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import { CATALOGS } from '../../src/i18n/i18n.svelte.ts';
import manifest from '../../src/tools/user-agent/manifest.ts';
import { MAX_USER_AGENT_LENGTH } from '../../src/tools/user-agent/user-agent.ts';
import { toaster } from '../../src/ui/toast.svelte.ts';
import { openTool } from '../tool-helpers.ts';

type User = ReturnType<typeof userEvent.setup>;

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';

afterEach(() => {
  toaster.clear();
  vi.restoreAllMocks();
  i18n.setLocale('en');
});

describe('user-agent', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/user-agent with exactly one heading: its name', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/user-agent');
    expect(view.headings).toEqual(['User-agent parser']);
    expect(view.main.textContent).toContain('Your files stay in this browser');
  });

  it('is found by search, in both languages of its keywords', async () => {
    const view = await openTool(manifest);
    expect(view.searchHits('user agent')).toEqual(['user-agent']);
    expect(view.searchHits('betriebssystem')).toEqual(['user-agent']);
    expect(view.searchHits('crawler')).toEqual(['user-agent']);
  });
});

function input(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'User-agent string' });
}

async function paste(user: User, text: string): Promise<void> {
  await user.clear(input());
  if (text !== '') {
    await user.click(input());
    await user.paste(text);
  }
}

/** The result table as label to value. */
function rows(): Map<string, string> {
  const table = screen.queryByRole('table');
  if (table === null) {
    return new Map();
  }
  return new Map(
    within(table)
      .getAllByRole('row')
      .map((row) => [
        within(row).getByRole('rowheader').textContent,
        within(row).getByRole('cell').textContent,
      ]),
  );
}

/** The tool's own live region (the others on the page are the search count and the announcer). */
function statusText(): string {
  return document.querySelector('main .tool-status')?.textContent.trim() ?? 'NO REGION';
}

function noteList(): string[] {
  return [...document.querySelectorAll('.notes li')].map((item) => item.textContent);
}

describe('reading a string', () => {
  let user: User;

  beforeEach(async () => {
    user = userEvent.setup();
    await openTool(manifest);
  });

  it('starts empty, and says what to do', () => {
    expect(input().value).toBe('');
    expect(rows().size).toBe(0);
    expect(screen.getByText('Paste a user-agent string to see what it says.')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'Notes' })).toBeNull();
    expect(statusText()).toBe('');
  });

  it('shows browser, engine, system, device, type and CPU of a pasted string', async () => {
    await paste(user, CHROME_WINDOWS);
    expect([...rows()]).toEqual([
      ['Browser', 'Chrome 119.0.0.0'],
      ['Engine', 'Blink 119.0.0.0'],
      ['Operating system', 'Windows 10 or 11'],
      ['Device', 'Not recognised'],
      ['Type', 'Computer'],
      ['CPU architecture', 'x86-64'],
    ]);
  });

  it('shows maker and model of a device', async () => {
    await paste(user, IPHONE);
    expect(rows().get('Device')).toBe('Apple iPhone');
    expect(rows().get('Type')).toBe('Phone');
    expect(rows().get('Operating system')).toBe('iOS 17.1');
    expect(rows().get('CPU architecture')).toBe('Not recognised');
  });

  it('announces a summary when the field is left', async () => {
    await paste(user, CHROME_WINDOWS);
    expect(statusText()).toBe('');
    await user.tab();
    expect(statusText()).toBe('Chrome 119.0.0.0 on Windows 10 or 11, Computer');
  });

  it('summarises a string with only a browser, only a system, or nothing', async () => {
    await paste(user, 'curl/8.4.0');
    await user.tab();
    expect(statusText()).toBe('curl 8.4.0, Program or library');
    await paste(user, 'Mozilla/5.0 (X11; Linux x86_64)');
    await user.tab();
    expect(statusText()).toBe('Linux, Computer');
    await paste(user, 'hello');
    await user.tab();
    expect(statusText()).toBe('Nothing in this string is recognised.');
    expect(rows().get('Browser')).toBe('Not recognised');
  });

  it('says nothing after the field is emptied', async () => {
    await paste(user, 'curl/8.4.0');
    await user.tab();
    await paste(user, '   ');
    await user.tab();
    expect(statusText()).toBe('');
    expect(rows().size).toBe(0);
  });

  it('lists the notes that belong to the string, and the one that always applies', async () => {
    await paste(user, CHROME_WINDOWS);
    expect(noteList()).toEqual([
      'Windows 10 and Windows 11 send the same version (10.0), so they look alike.',
      'A user-agent string can say anything its sender likes: take the result as a hint.',
    ]);
    await paste(
      user,
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.1 Safari/605.1.15',
    );
    expect(noteList()[0]).toContain('macOS 10.15.7');
    await paste(
      user,
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/119.0.0.0 Mobile Safari/537.36',
    );
    expect(noteList()[0]).toContain('reduced user-agent');
    await paste(user, 'curl/8.4.0');
    expect(noteList()).toEqual([
      'A user-agent string can say anything its sender likes: take the result as a hint.',
    ]);
  });

  it('refuses a text that is too long, and does not parse it', async () => {
    await paste(user, 'x'.repeat(MAX_USER_AGENT_LENGTH + 1));
    expect(document.querySelector('.sc-fld__error')?.textContent).toBe(
      'This text is too long for a user-agent string (at most 2,000 characters).',
    );
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(rows().size).toBe(0);
    await user.tab();
    expect(statusText()).toContain('too long');
    await paste(user, 'x'.repeat(MAX_USER_AGENT_LENGTH));
    expect(document.querySelector('.sc-fld__error')).toBeNull();
    expect(rows().get('Browser')).toBe('Not recognised');
  });

  it('clears the field, the result and the announcement', async () => {
    await paste(user, CHROME_WINDOWS);
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(input().value).toBe('');
    expect(rows().size).toBe(0);
    expect(statusText()).toBe('');
  });
});

describe('reading the own user agent', () => {
  it('reads it only when the button is pressed, and announces it', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(CHROME_WINDOWS);
    await openTool(manifest);
    expect(input().value).toBe('');
    expect(screen.getByText(/It stays on this page/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Use my browser' }));
    expect(input().value).toBe(CHROME_WINDOWS);
    expect(rows().get('Browser')).toBe('Chrome 119.0.0.0');
    expect(statusText()).toBe('Chrome 119.0.0.0 on Windows 10 or 11, Computer');
  });
});

describe('copying', () => {
  it('copies the result as JSON and confirms it', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    expect(screen.queryByRole('button', { name: 'Copy result' })).toBeNull();
    await paste(user, CHROME_WINDOWS);
    await user.click(screen.getByRole('button', { name: 'Copy result' }));
    const copied = JSON.parse(await navigator.clipboard.readText()) as Record<string, unknown>;
    expect(copied).toMatchObject({
      browser: { name: 'Chrome', version: '119.0.0.0' },
      engine: { name: 'Blink' },
      os: { name: 'Windows', version: '10 or 11' },
      device: { type: 'desktop' },
      cpu: 'x86-64',
      notes: ['windows-10-11'],
    });
    const region = screen.getByRole('region', { name: 'Notifications' });
    await waitFor(() => {
      expect(region.textContent).toContain('Copied Result');
    });
  });

  it('says so when the clipboard refuses', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, CHROME_WINDOWS);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy result' }));
    const region = screen.getByRole('region', { name: 'Notifications' });
    await waitFor(() => {
      expect(region.textContent).toContain('Could not copy');
    });
  });
});

describe('in German', () => {
  it('shows German labels and keeps the product names', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    i18n.setLocale('de');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('User-Agent-Parser');
    });
    const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'User-Agent-String' });
    await user.click(field);
    await user.paste(IPHONE);
    await user.tab();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('rowheader', { name: 'Betriebssystem' })).toBeTruthy();
    expect(table.textContent).toContain('iOS 17.1');
    expect(table.textContent).toContain('Smartphone');
    expect(statusText()).toBe('Safari 17.1 auf iOS 17.1, Smartphone');
  });

  it('has every text of the tool in both languages', () => {
    const own = Object.keys(CATALOGS.en).filter((key) => key.startsWith('ua.'));
    expect(own.length).toBeGreaterThan(30);
    for (const key of own) {
      expect(Object.keys(CATALOGS.de), key).toContain(key);
    }
  });
});
