import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import { findMatches, type Input } from '../../src/tools/regex/match.ts';
import manifest from '../../src/tools/regex/manifest.ts';
import { openTool } from '../tool-helpers.ts';
import { FIELD_ERROR, fieldErrorText } from '../helpers.ts';

type User = ReturnType<typeof userEvent.setup>;

const pool = vi.hoisted(() => ({
  behaviour: 'real',
  release: undefined as (() => void) | undefined,
  created: 0,
  terminated: 0,
  jobs: [] as unknown[],
  run: undefined as unknown as (input: unknown, options: unknown) => Promise<unknown>,
}));

vi.mock('../../src/tools/regex/pool.ts', () => ({
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
  pool.release = undefined;
  pool.created = 0;
  pool.terminated = 0;
  pool.jobs = [];
  pool.run = (input, options) => {
    pool.jobs.push(input);
    const { signal } = options as { signal: AbortSignal };
    if (pool.behaviour === 'fail') {
      return Promise.reject(new Error('boom'));
    }
    if (pool.behaviour === 'late') {
      // Answers only when the test says so, and does not care that it was aborted.
      return new Promise((resolve) => {
        pool.release = () => {
          resolve(findMatches(input as Input));
        };
      });
    }
    if (pool.behaviour === 'hang') {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      });
    }
    return Promise.resolve(findMatches(input as Input));
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  i18n.setLocale('en');
});

function pattern(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'Pattern' });
}

function testText(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Text to test' });
}

async function replace(user: User, field: HTMLElement, value: string): Promise<void> {
  await user.clear(field);
  if (value !== '') {
    await user.click(field);
    await user.paste(value);
  }
}

function statusText(): string {
  return [...document.querySelectorAll('main .tool-status')]
    .map((region) => region.textContent.trim())
    .filter((text) => text !== '')
    .join('|');
}

function marked(): string[] {
  return [...document.querySelectorAll('mark')].map((mark) => mark.textContent);
}

function matchRows(): string[][] {
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
        .map((cell) => {
          const items = [...cell.querySelectorAll('li')];
          const text =
            items.length > 0 ? items.map((item) => item.textContent).join(' | ') : cell.textContent;
          return text.replace(/\s+/g, ' ').trim();
        }),
    ]);
}

function explanation(): string[] {
  return [...document.querySelectorAll('.explain li')].map((item) =>
    item.textContent.replace(/\s+/g, ' ').trim(),
  );
}

describe('regex', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/regex with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/regex');
    expect(view.headings).toEqual(['Regex tester']);
    expect(view.searchHits('regular expression')).toEqual(['regex']);
    expect(view.searchHits('regulärer ausdruck')).toEqual(['regex']);
  });
});

describe('testing a pattern', () => {
  let user: User;

  beforeEach(async () => {
    user = userEvent.setup();
    await openTool(manifest);
  });

  it('starts with a working example: matches, groups, marks and an explanation', async () => {
    await waitFor(() => {
      expect(matchRows()).toHaveLength(2);
    });
    expect(matchRows()[0]).toEqual(['1', '9', '2026-06-01', '1 2026 | 2 06 | 3 01']);
    expect(marked()).toEqual(['2026-06-01', '2026-06-15']);
    expect(statusText()).toBe('2 matches found.');
    expect(explanation()[0]).toBe(String.raw`(` + ' Group 1, remembered, containing:');
  });

  it('follows the pattern and the text, and announces the count (singular too)', async () => {
    await replace(user, pattern(), 'cat');
    await replace(user, testText(), 'one cat, two dogs');
    await waitFor(() => {
      expect(statusText()).toBe('1 match found.');
    });
    expect(marked()).toEqual(['cat']);
    expect(matchRows()).toEqual([['1', '4', 'cat', '']]);
    expect(explanation()).toEqual(['cat The text "cat"']);
  });

  it('says when nothing matches and shows no table', async () => {
    await replace(user, pattern(), 'zzz');
    await waitFor(() => {
      expect(statusText()).toBe('No match.');
    });
    expect(screen.queryByRole('table')).toBeNull();
    expect(marked()).toEqual([]);
  });

  it('shows named groups, groups that did not take part and empty ones', async () => {
    await replace(user, pattern(), '(?<word>b)(c)?(d*)');
    await replace(user, testText(), 'ab');
    await waitFor(() => {
      expect(matchRows()).toHaveLength(1);
    });
    expect(matchRows()[0]).toEqual([
      '1',
      '1',
      'b',
      '1 b | 2 (did not take part) | 3 (empty) | word b',
    ]);
  });

  it('shows an empty match as such and marks nothing for it', async () => {
    await replace(user, pattern(), 'x*');
    await replace(user, testText(), 'ab');
    await waitFor(() => {
      expect(matchRows()).toHaveLength(3);
    });
    expect(matchRows()[0]?.[2]).toBe('(empty)');
    expect(marked()).toEqual([]);
  });

  it('reads the flags: the first match only without g, ignoring case with i', async () => {
    await replace(user, pattern(), 'a');
    await replace(user, testText(), 'aAa');
    await waitFor(() => {
      expect(matchRows()).toHaveLength(2);
    });
    await user.click(screen.getByRole('checkbox', { name: /^g: find every match/ }));
    await waitFor(() => {
      expect(matchRows()).toHaveLength(1);
    });
    await user.click(screen.getByRole('checkbox', { name: /^g: find every match/ }));
    await user.click(screen.getByRole('checkbox', { name: /^i: ignore upper and lower case/ }));
    await waitFor(() => {
      expect(matchRows()).toHaveLength(3);
    });
    expect(pool.jobs.at(-1)).toMatchObject({ flags: 'gi' });
  });

  it('marks a pattern the browser rejects, with its message, and runs nothing', async () => {
    const before = pool.jobs.length;
    await replace(user, pattern(), 'a(');
    expect(pattern().getAttribute('aria-invalid')).toBe('true');
    expect(fieldErrorText()).toContain('This is not a valid pattern: Invalid regular expression');
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.querySelector('.explain')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(pool.jobs.length).toBe(before);
    await replace(user, pattern(), 'a');
    expect(pattern().getAttribute('aria-invalid')).toBeNull();
  });

  it('refuses flags that cannot be combined', async () => {
    await user.click(screen.getByRole('checkbox', { name: /^u: Unicode mode/ }));
    await user.click(screen.getByRole('checkbox', { name: /^v: Unicode sets mode/ }));
    expect(fieldErrorText()).toContain('Invalid flags');
  });

  it('shows nothing for an empty pattern', async () => {
    await replace(user, pattern(), '');
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.querySelector('.explain')).toBeNull();
    expect(statusText()).toBe('');
  });

  it('limits the length of the pattern and of the text', async () => {
    await replace(user, pattern(), 'a'.repeat(2001));
    expect(fieldErrorText()).toBe('This pattern is too long (at most 2,000 characters).');
    await replace(user, pattern(), 'a');
    await user.click(testText());
    await user.paste('a'.repeat(200_001));
    expect(
      [...document.querySelectorAll(FIELD_ERROR)].map((error) => error.textContent.trim()),
    ).toEqual(['This text is too long (at most 200,000 characters).']);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says when there are more matches than are shown', async () => {
    await replace(user, pattern(), 'a');
    await user.click(testText());
    await user.paste('a'.repeat(1500));
    await waitFor(
      () => {
        expect(statusText()).toBe('The first 1,000 matches are shown; there are more.');
      },
      { timeout: 10_000 },
    );
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1000);
  }, 30_000);

  it('explains lazy repetition, classes and look-around in plain words', async () => {
    await replace(user, pattern(), String.raw`(?<=\$)[0-9]+?\b`);
    await waitFor(() => {
      expect(explanation().length).toBeGreaterThan(3);
    });
    expect(explanation()).toEqual([
      '(?<= Preceded by (not used up):',
      String.raw`\$ The text "$"`,
      '[0-9] One character out of these:',
      '0-9 A character from "0" to "9"',
      '+? The part before: one or more times, as few as possible',
      String.raw`\b A word boundary: between a word character and something else`,
    ]);
  });
});

describe('a pattern that runs away', () => {
  let user: User;

  beforeEach(async () => {
    user = userEvent.setup();
    await openTool(manifest);
    await waitFor(() => {
      expect(matchRows()).toHaveLength(2);
    });
  });

  it('is stopped after two seconds, and the page says why', async () => {
    pool.behaviour = 'hang';
    await replace(user, pattern(), '(a+)+$');
    await waitFor(
      () => {
        expect(document.querySelector('main .tool-status.alert')?.textContent).toContain(
          'Stopped after 2 seconds.',
        );
      },
      { timeout: 4500 },
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(statusText()).toContain('Stopped after 2 seconds');
    expect(pool.terminated).toBe(0);
    // The page recovers with the next edit.
    pool.behaviour = 'real';
    await replace(user, pattern(), 'a');
    await waitFor(() => {
      expect(document.querySelector('main .tool-status.alert')?.textContent).toBe('');
    });
  }, 15_000);

  it('reports a failure of the worker, which is not a timeout', async () => {
    pool.behaviour = 'fail';
    await replace(user, pattern(), 'b');
    await waitFor(() => {
      expect(document.querySelector('main .tool-status.alert')?.textContent).toBe(
        'The match could not be run. Change the pattern or the text and try again.',
      );
    });
  });

  it('drops the answer of a match that finishes after the pattern became invalid', async () => {
    pool.behaviour = 'late';
    await replace(user, pattern(), 'b');
    await waitFor(() => {
      expect(pool.release).toBeDefined();
    });
    await replace(user, pattern(), 'b(');
    expect(fieldErrorText()).not.toBeNull();
    pool.release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.querySelector('mark')).toBeNull();
    expect(statusText()).toBe('');
  });

  it('drops a job that a newer edit replaced, without an error', async () => {
    pool.behaviour = 'hang';
    await replace(user, pattern(), 'b');
    await waitFor(() => {
      expect(pool.jobs.at(-1)).toMatchObject({ pattern: 'b' });
    });
    pool.behaviour = 'real';
    await replace(user, pattern(), 'c');
    await waitFor(() => {
      expect(pool.jobs.at(-1)).toMatchObject({ pattern: 'c' });
    });
    expect(document.querySelector('main .tool-status.alert')?.textContent).toBe('');
    expect(pool.created).toBe(1);
  });
});

describe('regex in German', () => {
  it('shows German texts and the German explanation', async () => {
    await openTool(manifest);
    i18n.setLocale('de');
    expect(await screen.findByRole('textbox', { name: 'Muster' })).toBeTruthy();
    await waitFor(() => {
      expect(explanation()[0]).toBe('( Gruppe 1, gemerkt, mit:');
    });
  });
});
