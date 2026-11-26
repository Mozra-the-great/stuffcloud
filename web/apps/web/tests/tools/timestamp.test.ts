import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/timestamp/manifest.ts';
import { toast } from '@mozra-the-great/kern';
import { openTool } from '../tool-helpers.ts';
import { fieldErrorText } from '../helpers.ts';

type User = ReturnType<typeof userEvent.setup>;

/** Monday 2026-06-01, 10:00 UTC: the moment the page "opens". */
const NOW = Date.UTC(2026, 5, 1, 10, 0, 0);

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  toast.clear();
  vi.restoreAllMocks();
  i18n.setLocale('en');
});

function input(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'Timestamp or date' });
}

function zone(): HTMLSelectElement {
  return screen.getByRole<HTMLSelectElement>('combobox', { name: 'Time zone' });
}

function unit(): HTMLSelectElement {
  return screen.getByRole<HTMLSelectElement>('combobox', { name: 'Unit of an epoch number' });
}

async function open(): Promise<User> {
  const user = userEvent.setup();
  await openTool(manifest);
  await user.selectOptions(zone(), 'UTC');
  return user;
}

async function enter(user: User, text: string): Promise<void> {
  await user.clear(input());
  await user.click(input());
  if (text !== '') {
    await user.paste(text);
  }
}

function rows(): Record<string, string> {
  const table = screen.queryByRole('table');
  if (table === null) {
    return {};
  }
  return Object.fromEntries(
    within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => [
        within(row).getByRole('rowheader').textContent,
        within(row).getAllByRole('cell')[0]?.textContent ?? '',
      ]),
  );
}

function statusText(): string {
  return [...document.querySelectorAll('main .tool-status')]
    .map((region) => region.textContent.trim())
    .filter((text) => text !== '')
    .join('|');
}

describe('timestamp', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/timestamp with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/timestamp');
    expect(view.headings).toEqual(['Timestamp converter']);
    expect(view.searchHits('epoch')).toEqual(['timestamp']);
    expect(view.searchHits('zeitstempel')).toEqual(['timestamp']);
  });
});

describe('converting', () => {
  it('starts with the current time and lists every format', async () => {
    await open();
    expect(input().value).toBe('1780308000');
    expect(rows()).toEqual({
      'Epoch seconds': '1780308000',
      'Epoch milliseconds': '1780308000000',
      'ISO 8601, UTC': '2026-06-01T10:00:00.000Z',
      'ISO 8601 in UTC': '2026-06-01T10:00:00+00:00',
      'In words, UTC': 'Monday, June 1, 2026 at 10:00:00 AM UTC',
      'HTTP date (GMT)': 'Mon, 01 Jun 2026 10:00:00 GMT',
    });
    expect(document.querySelector('.relative')?.textContent).toBe('now');
    expect(screen.getByText(/Read as seconds since 1970/)).toBeTruthy();
  });

  it('reads milliseconds and says so', async () => {
    const user = await open();
    await enter(user, '1780308000000');
    expect(rows()['Epoch seconds']).toBe('1780308000');
    expect(screen.getByText(/Read as milliseconds since 1970/)).toBeTruthy();
    await user.selectOptions(unit(), 'seconds');
    expect(screen.queryByText(/Read as/)).toBeNull();
  });

  it('shows the moment in another zone and relative to now', async () => {
    const user = await open();
    await enter(user, '2026-05-29T10:00:00Z');
    expect(document.querySelector('.relative')?.textContent).toBe('3 days ago');
    await user.selectOptions(zone(), 'Asia/Kolkata');
    expect(rows()['ISO 8601 in Asia/Kolkata']).toBe('2026-05-29T15:30:00+05:30');
    expect(rows()['In words, Asia/Kolkata']).toContain('Friday, May 29, 2026');
  });

  it('reads a time without an offset in the chosen zone', async () => {
    const user = await open();
    await user.selectOptions(zone(), 'Europe/Berlin');
    await enter(user, '2026-06-01T12:00:00');
    expect(rows()['ISO 8601, UTC']).toBe('2026-06-01T10:00:00.000Z');
    expect(document.querySelector('.relative')?.textContent).toBe('now');
  });

  it('warns about a clock time that happens twice', async () => {
    const user = await open();
    await user.selectOptions(zone(), 'Europe/Berlin');
    await enter(user, '2026-10-25T02:30:00');
    expect(screen.getByText(/happens twice in Europe\/Berlin/)).toBeTruthy();
    expect(rows()['ISO 8601, UTC']).toBe('2026-10-25T00:30:00.000Z');
  });

  it('marks input that cannot be read, in the field and in the live region', async () => {
    const user = await open();
    await enter(user, 'soon');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(fieldErrorText()).toContain('neither a number nor an ISO 8601 date');
    expect(screen.queryByRole('table')).toBeNull();
    await user.tab();
    expect(statusText()).toContain('neither a number nor an ISO 8601 date');
    await enter(user, '2026-02-30');
    expect(fieldErrorText()).toBe('This calendar date does not exist.');
    await user.selectOptions(zone(), 'Europe/Berlin');
    await enter(user, '2026-03-29T02:30:00');
    expect(fieldErrorText()).toBe(
      'This clock time does not exist in Europe/Berlin (the clocks skip it when they go forward).',
    );
    await enter(user, '');
    expect(fieldErrorText()).toBe('Enter a timestamp or a date.');
    await enter(user, '9'.repeat(101));
    expect(fieldErrorText()).toBe('This is too long (at most 100 characters).');
  });

  it('announces the moment when the field is left, but not on every key', async () => {
    const user = await open();
    await enter(user, '1780394400');
    expect(statusText()).not.toContain('2026-06-02');
    await user.tab();
    expect(statusText()).toBe('2026-06-02T10:00:00.000Z, tomorrow.');
  });

  it('puts in the current time, in the unit that is chosen', async () => {
    const user = await open();
    await enter(user, '5');
    await user.click(screen.getByRole('button', { name: 'Use the current time' }));
    expect(input().value).toBe('1780308000');
    expect(statusText()).toBe('The input is now the current time.');
    await user.selectOptions(unit(), 'milliseconds');
    await user.click(screen.getByRole('button', { name: 'Use the current time' }));
    expect(input().value).toBe('1780308000000');
  });

  it('copies a format and confirms it', async () => {
    const user = await open();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await user.click(screen.getByRole('button', { name: 'Copy ISO 8601 in UTC' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('2026-06-01T10:00:00.000Z');
    });
  });

  it('shows only the UTC formats for a moment far outside the years 1 to 9999', async () => {
    const user = await open();
    await enter(user, '8640000000000000');
    expect(Object.keys(rows())).toEqual([
      'Epoch seconds',
      'Epoch milliseconds',
      'ISO 8601, UTC',
      'HTTP date (GMT)',
    ]);
  });

  it('shows German texts and dates', async () => {
    await open();
    i18n.setLocale('de');
    expect(await screen.findByRole('textbox', { name: 'Zeitstempel oder Datum' })).toBeTruthy();
    expect(rows()['In Worten, UTC']).toContain('Montag, 1. Juni 2026');
    expect(document.querySelector('.relative')?.textContent).toBe('jetzt');
  });
});
