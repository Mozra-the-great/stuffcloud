import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import { CATALOGS } from '../../src/i18n/i18n.svelte.ts';
import type { CronErrorCode } from '../../src/tools/cron/cron.ts';
import manifest from '../../src/tools/cron/manifest.ts';
import { ERROR_KEYS, FIELD_KEYS } from '../../src/tools/cron/messages.ts';
import { toast } from '@mozra-the-great/kern';
import { openTool } from '../tool-helpers.ts';

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

describe('cron', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/cron with exactly one heading: its name', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/cron');
    expect(view.headings).toEqual(['CRON expression']);
    expect(view.main.textContent).toContain('Your files stay in this browser');
  });

  it('is found by search, in both languages of its keywords', async () => {
    const view = await openTool(manifest);
    expect(view.searchHits('cron expression')).toEqual(['cron']);
    expect(view.searchHits('crontab')).toEqual(['cron']);
    expect(view.searchHits('zeitplan')).toEqual(['cron']);
  });
});

function expression(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'CRON expression' });
}

function zone(): HTMLSelectElement {
  return screen.getByRole<HTMLSelectElement>('combobox', { name: 'Time zone' });
}

function count(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Number of runs' });
}

async function type(user: User, input: HTMLInputElement, text: string): Promise<void> {
  await user.clear(input);
  if (text !== '') {
    await user.type(input, text);
  }
}

function explanation(): string {
  return document.querySelector('.explanation')?.textContent ?? '';
}

/** The run table as rows of [no., local time, UTC]. */
function runTable(): string[][] {
  const table = screen.queryByRole('table');
  if (table === null) {
    return [];
  }
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => [
      within(row).getByRole('rowheader').textContent,
      ...within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ]);
}

function statusText(): string {
  return screen
    .getAllByRole('status')
    .map((region) => region.textContent.trim())
    .join('|');
}

function problemShown(): string | null {
  return document.querySelector('.sc-fld__error')?.textContent ?? null;
}

function notes(): string[] {
  return [...document.querySelectorAll('.note')].map((note) => note.textContent);
}

describe('reading an expression', () => {
  let user: User;

  beforeEach(async () => {
    user = userEvent.setup();
    await openTool(manifest);
    await user.selectOptions(zone(), 'UTC');
  });

  it('starts with a working example and its next runs', () => {
    expect(expression().value).toBe('*/15 9-17 * * 1-5');
    expect(explanation()).toBe(
      'Every 15 minutes from 09:00 through 17:59, from Monday through Friday',
    );
    expect(runTable()).toHaveLength(10);
    expect(runTable()[0]).toEqual(['1', expect.stringContaining('10:15'), '2026-06-01 10:15:00']);
    expect(runTable()[4]?.[2]).toBe('2026-06-01 11:15:00');
    expect(problemShown()).toBeNull();
  });

  it('explains what is typed, run by run, and says nothing while it is wrong', async () => {
    await type(user, expression(), '0 9 * * 1-5');
    expect(explanation()).toBe('At 09:00, from Monday through Friday');
    expect(runTable().map((row) => row[2])).toEqual([
      '2026-06-02 09:00:00',
      '2026-06-03 09:00:00',
      '2026-06-04 09:00:00',
      '2026-06-05 09:00:00',
      '2026-06-08 09:00:00',
      '2026-06-09 09:00:00',
      '2026-06-10 09:00:00',
      '2026-06-11 09:00:00',
      '2026-06-12 09:00:00',
      '2026-06-15 09:00:00',
    ]);
    expect(screen.getByRole('heading', { level: 2, name: 'In plain language' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Next runs' })).toBeTruthy();
  });

  it('announces the explanation and the next run when the field is left', async () => {
    await type(user, expression(), '0 9 * * 1-5');
    expect(statusText()).not.toContain('At 09:00, from Monday');
    await user.tab();
    expect(statusText()).toContain('At 09:00, from Monday through Friday. Next run:');
    expect(statusText()).toContain('09:00');
  });

  it('shows what is wrong, marks the field, and announces it', async () => {
    await type(user, expression(), '61 * * * *');
    expect(problemShown()).toBe('Minute: "61" is outside 0 to 59.');
    expect(expression().getAttribute('aria-invalid')).toBe('true');
    expect(explanation()).toBe('');
    expect(runTable()).toEqual([]);
    expect(screen.queryByRole('heading', { level: 2, name: 'Next runs' })).toBeNull();
    await user.tab();
    expect(statusText()).toContain('Minute: "61" is outside 0 to 59.');
  });

  it('reports every field that is wrong', async () => {
    await type(user, expression(), '61 25 * * *');
    expect(problemShown()).toBe('Minute: "61" is outside 0 to 59. Hour: "25" is outside 0 to 23.');
  });

  it('has a message for every kind of error, with nothing left to fill in', async () => {
    const samples: Readonly<Record<CronErrorCode, string>> = {
      empty: '',
      'too-long': '*'.repeat(501),
      'field-count': '* * *',
      'unknown-macro': '@sometimes',
      reboot: '@reboot',
      'empty-item': '1,,2 * * * *',
      syntax: 'x * * * *',
      'out-of-range': '60 * * * *',
      'range-order': '9-5 * * * *',
      'step-zero': '*/0 * * * *',
      'step-too-large': '*/61 * * * *',
      'unsupported-special': '0 0 L * *',
      'bad-nth': '0 0 0 ? * 5#9',
    };
    expect(Object.keys(samples).sort()).toEqual(Object.keys(ERROR_KEYS).sort());
    for (const [code, text] of Object.entries(samples)) {
      if (text.length > 100) {
        // Typing 500 characters one by one is slow; the field takes a pasted text.
        await user.click(expression());
        await user.clear(expression());
        await user.paste(text);
      } else {
        await type(user, expression(), text);
      }
      const shown = problemShown() ?? '';
      expect(shown, code).not.toBe('');
      expect(shown, code).not.toMatch(/[{}]/);
    }
  });

  it('has a name for every field and a text in both languages for every message', () => {
    for (const key of [...Object.values(ERROR_KEYS), ...Object.values(FIELD_KEYS)]) {
      expect(CATALOGS.en[key], key).toBeDefined();
      expect(CATALOGS.de[key], key).toBeDefined();
    }
  });

  it('shows the macro written out', async () => {
    await type(user, expression(), '@daily');
    expect(explanation()).toBe('At 00:00 every day');
    expect(notes()).toContain('Written out: 0 0 * * *');
    await type(user, expression(), '* * * * *');
    expect(notes().join('|')).not.toContain('Written out');
  });

  it('explains how the two day fields work together', async () => {
    await type(user, expression(), '0 0 13 * 5');
    expect(explanation()).toBe('At 00:00, on day 13 of the month or on Friday');
    expect(notes().join('|')).toContain('runs on every day that matches either of them');
    await type(user, expression(), '0 0 */2 * 1');
    expect(notes().join('|')).toContain('has to match both of them');
    await type(user, expression(), '0 0 13 * *');
    expect(notes().join('|')).not.toContain('either of them');
    expect(notes().join('|')).not.toContain('both of them');
  });

  it('tells how weekday numbers are counted when seconds or a year are used', async () => {
    expect(notes().join('|')).not.toContain('Quartz');
    await type(user, expression(), '0 0 9 ? * MON#2');
    expect(notes().join('|')).toContain('Quartz counts Sunday as 1');
    expect(explanation()).toBe('At 09:00, on the second Monday of the month');
  });

  it('says what happens at clock changes, under the runs only', async () => {
    expect(notes().join('|')).toContain('a time the clock skips is not run');
    await type(user, expression(), 'x');
    expect(notes().join('|')).not.toContain('clock skips');
  });
});

describe('time zone and number of runs', () => {
  let user: User;

  beforeEach(async () => {
    user = userEvent.setup();
    await openTool(manifest);
    await type(user, expression(), '0 9 * * *');
  });

  it('offers UTC first and the zones of the browser', () => {
    const options = within(zone())
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);
    expect(options[0]).toBe('UTC');
    expect(options).toContain('Europe/Berlin');
    expect(options.length).toBeGreaterThan(20);
  });

  it('reads the clock of the chosen zone', async () => {
    await user.selectOptions(zone(), 'Europe/Berlin');
    expect(runTable()[0]?.[2]).toBe('2026-06-02 07:00:00');
    expect(runTable()[0]?.[1]).toContain('09:00');
    expect(runTable()[0]?.[1]).toContain('2026');
    expect(screen.getByRole('columnheader', { name: 'Time in Europe/Berlin' })).toBeTruthy();
    await user.selectOptions(zone(), 'Asia/Kolkata');
    expect(runTable()[0]?.[2]).toBe('2026-06-02 03:30:00');
    await user.selectOptions(zone(), 'UTC');
    expect(runTable()[0]?.[2]).toBe('2026-06-02 09:00:00');
  });

  it('announces a change of zone', async () => {
    await user.selectOptions(zone(), 'Europe/Berlin');
    expect(statusText()).toContain('At 09:00 every day. Next run:');
  });

  it('lists as many runs as asked for', async () => {
    await type(user, count(), '3');
    expect(runTable()).toHaveLength(3);
    await type(user, count(), '50');
    expect(runTable()).toHaveLength(50);
    await type(user, count(), '1');
    expect(runTable()).toHaveLength(1);
  });

  it.each(['0', '51', '', 'abc', '2.5', '-1', '1000'])('refuses "%s" runs', async (text) => {
    await type(user, count(), text);
    expect(problemShown()).toBe('Enter a whole number from 1 to 50.');
    expect(runTable()).toEqual([]);
    expect(explanation()).toBe('At 09:00 every day');
  });

  it('shows seconds when the expression has them', async () => {
    await type(user, expression(), '*/20 * * * * *');
    await user.selectOptions(zone(), 'UTC');
    expect(runTable()[0]?.[1]).toMatch(/10:00:20/);
    await type(user, expression(), '0 9 * * *');
    expect(runTable()[0]?.[1]).not.toMatch(/09:00:00/);
  });

  it('says so when the schedule has no more runs, or only a few', async () => {
    await type(user, expression(), '0 0 30 2 *');
    expect(runTable()).toEqual([]);
    expect(notes()).toContain('This schedule never runs again.');
    await type(user, expression(), '0 0 0 1 1 ? 2027,2028');
    expect(runTable()).toHaveLength(2);
    expect(notes()).toContain('Only 2 runs are left; the schedule ends after them.');
    await type(user, expression(), '0 0 0 1 1 ? 2027');
    await type(user, count(), '2');
    expect(notes()).toContain('Only 1 run is left; the schedule ends after it.');
  });

  it('copies the explanation and confirms it', async () => {
    await user.click(screen.getByRole('button', { name: 'Copy explanation' }));
    expect(await navigator.clipboard.readText()).toBe('At 09:00 every day');
    const region = screen.getByRole('region', { name: 'Notifications' });
    await waitFor(() => {
      expect(region.textContent).toContain('Copied At 09:00 every day');
    });
  });

  it('says so when the clipboard refuses', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy explanation' }));
    const region = screen.getByRole('region', { name: 'Notifications' });
    await waitFor(() => {
      expect(region.textContent).toContain('Could not copy');
    });
  });
});

describe('in German', () => {
  it('explains in German, with German messages and dates', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    i18n.setLocale('de');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('CRON-Ausdruck');
    });
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'CRON-Ausdruck' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Zeitzone' }), 'UTC');
    await type(user, input, '0 9 * * 1-5');
    expect(explanation()).toBe('Um 09:00 Uhr, von Montag bis Freitag');
    expect(runTable()[0]?.[1]).toContain('Di.');
    await type(user, input, '61 * * * *');
    expect(problemShown()).toBe('Minute: „61“ liegt außerhalb von 0 bis 59.');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('CRON-Ausdruck');
  });
});
