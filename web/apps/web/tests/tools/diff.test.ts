import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/diff/manifest.ts';
import type * as DiffTask from '../../src/tools/diff/task.ts';
import { runTask, type Input, type Output } from '../../src/tools/diff/task.ts';
import { openTool } from '../tool-helpers.ts';
import { defined } from './defined.ts';
import { fieldErrorText } from '../helpers.ts';

const pool = vi.hoisted(() => ({
  behaviour: 'real',
  release: undefined as (() => void) | undefined,
  created: 0,
  terminated: 0,
  jobs: [] as unknown[],
  override: undefined as Output | undefined,
  run: undefined as unknown as (input: unknown, options: unknown) => Promise<unknown>,
}));

vi.mock('../../src/tools/diff/pool.ts', () => ({
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

// Short limits, so the tests of the limits do not need seconds or megabytes.
vi.mock('../../src/tools/diff/task.ts', async (importOriginal) => {
  const original = await importOriginal<typeof DiffTask>();
  return { ...original, DIFF_TIMEOUT_MS: 400, MAX_TEXT_LENGTH: 200, MAX_ROWS: 6 };
});

type User = ReturnType<typeof userEvent.setup>;

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
  pool.override = undefined;
  pool.run = (input, options) => {
    pool.jobs.push(input);
    const { signal } = options as { signal: AbortSignal };
    const compute = (): Output => {
      const real = runTask(input as Input, { progress: () => undefined });
      return pool.override ?? real;
    };
    if (pool.behaviour === 'fail') {
      return Promise.reject(new Error('boom'));
    }
    if (pool.behaviour === 'late') {
      return new Promise((resolve) => {
        pool.release = () => {
          resolve(compute());
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
    return Promise.resolve(compute());
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  i18n.setLocale('en');
});

function field(name: 'Original' | 'Changed'): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name });
}

async function setText(name: 'Original' | 'Changed', value: string): Promise<void> {
  await fireEvent.input(field(name), { target: { value } });
}

function statusText(): string {
  return document.querySelector('main .tool-status:not(.alert)')?.textContent.trim() ?? '';
}

function alertText(): string {
  return document.querySelector('main .tool-status.alert')?.textContent.trim() ?? '';
}

function table(): HTMLElement | null {
  return document.querySelector('table.diff');
}

function bodyRows(): HTMLTableRowElement[] {
  return [...document.querySelectorAll<HTMLTableRowElement>('table.diff tbody tr')];
}

async function ready(): Promise<void> {
  await waitFor(() => {
    expect(statusText()).not.toBe('');
  });
}

async function opened(): Promise<User> {
  const user = userEvent.setup();
  await openTool(manifest);
  await ready();
  return user;
}

describe('diff', () => {
  it('keeps the privacy promise in its manifest and needs a worker', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
    expect(manifest.requires).toContain('worker');
  });

  it('opens at /tools/diff with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/diff');
    expect(view.headings).toEqual(['Text diff']);
    expect(view.searchHits('text diff')).toEqual(['diff']);
    expect(view.searchHits('vergleichen')).toEqual(['diff']);
  });
});

describe('the line view, side by side', () => {
  it('compares the example texts and says what changed', async () => {
    await opened();
    expect(statusText()).toBe('Lines: 2 added, 1 removed.');
    expect(table()?.getAttribute('aria-label')).toBe('Differences, side by side');
    const headers = [...document.querySelectorAll('table.diff thead th')].map((cell) =>
      cell.textContent.trim(),
    );
    expect(headers).toEqual(['Original', 'Changed']);
    // One changed pair (with the word marked), two unchanged lines and one added line.
    expect(bodyRows()).toHaveLength(4);
    const changed = defined(bodyRows()[0]);
    expect(within(changed).getByText('brown').tagName).toBe('DEL');
    expect(within(changed).getByText('red').tagName).toBe('INS');
    expect(changed.querySelectorAll('.visually-hidden')).toHaveLength(2);
    expect(changed.textContent).toContain('Removed line');
    expect(changed.textContent).toContain('Added line');
    const added = defined(bodyRows()[3]);
    expect(added.textContent).toContain('Good dog!');
    expect(added.textContent).toContain('Added line');
    expect(added.textContent).not.toContain('Removed line');
  });

  it('numbers each side by its own lines', async () => {
    const user = await opened();
    await setText('Original', 'a\nb\nc');
    await setText('Changed', 'a\nc\nd');
    await waitFor(() => {
      expect(statusText()).toBe('Lines: 1 added, 1 removed.');
    });
    const rows = bodyRows().map((row) =>
      [...row.querySelectorAll('td.num')].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ['1', '1'],
      ['2', ''],
      ['3', '2'],
      ['', '3'],
    ]);
    expect(user).toBeDefined();
  });

  it('folds long unchanged runs and shows them all on request', async () => {
    const user = await opened();
    const lines = Array.from({ length: 40 }, (_, index) => `line ${String(index + 1)}`);
    const edited = lines.map((line, index) => (index === 20 ? 'changed' : line));
    await setText('Original', lines.join('\n').slice(0, 190));
    await setText('Changed', edited.join('\n').slice(0, 190));
    await waitFor(() => {
      expect(document.querySelector('tr.skipped')).not.toBeNull();
    });
    expect(document.querySelector('tr.skipped')?.textContent).toMatch(/^\d+ unchanged lines$/);
    await user.click(screen.getByRole('checkbox', { name: 'Show unchanged lines too' }));
    await waitFor(() => {
      expect(document.querySelector('tr.skipped')).toBeNull();
    });
    expect(pool.jobs.at(-1)).toMatchObject({ context: -1 });
  });

  it('says the texts are identical and shows no table', async () => {
    await opened();
    await setText('Changed', 'The quick brown fox\njumps over\nthe lazy dog.\n');
    await waitFor(() => {
      expect(statusText()).toBe('The texts are identical.');
    });
    expect(table()).toBeNull();
    expect(screen.getAllByText('The texts are identical.').length).toBeGreaterThanOrEqual(2);
  });

  it('shows an empty side as all added', async () => {
    await opened();
    await setText('Original', '');
    await waitFor(() => {
      expect(statusText()).toBe('Lines: 4 added, 0 removed.');
    });
    expect(bodyRows().every((row) => row.querySelector('td.added') !== null)).toBe(true);
  });
});

describe('the other views', () => {
  it('shows the line view inline: a removed and an added row for each change', async () => {
    const user = await opened();
    await user.selectOptions(screen.getByRole('combobox', { name: 'View' }), 'inline');
    expect(table()?.getAttribute('aria-label')).toBe('Differences, inline');
    const kinds = bodyRows().map((row) => {
      const cell = row.querySelector('td.text');
      return cell?.classList.contains('removed') === true
        ? 'removed'
        : cell?.classList.contains('added') === true
          ? 'added'
          : 'same';
    });
    expect(kinds).toEqual(['removed', 'added', 'same', 'same', 'added']);
    const first = defined(bodyRows()[0]);
    expect(within(first).getByText('brown').tagName).toBe('DEL');
    const second = defined(bodyRows()[1]);
    expect(within(second).getByText('red').tagName).toBe('INS');
  });

  it('compares by words inline and side by side', async () => {
    const user = await opened();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Compare by' }), 'words');
    await waitFor(() => {
      expect(statusText()).toBe('Words: 3 added, 1 removed.');
    });
    expect(table()).toBeNull();
    const boxes = [...document.querySelectorAll('.flow-box')];
    expect(boxes).toHaveLength(2);
    expect(within(boxes[0] as HTMLElement).getByText('brown').tagName).toBe('DEL');
    expect(within(boxes[0] as HTMLElement).queryByText('red')).toBeNull();
    expect(within(boxes[1] as HTMLElement).getByText('red').tagName).toBe('INS');
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(['Original', 'Changed']);
    await user.selectOptions(screen.getByRole('combobox', { name: 'View' }), 'inline');
    expect(document.querySelectorAll('.flow-box')).toHaveLength(0);
    const flow = defined(document.querySelector<HTMLElement>('p.flow'));
    expect(within(flow).getByText('brown').tagName).toBe('DEL');
    expect(within(flow).getByText('red').tagName).toBe('INS');
    expect(screen.queryByRole('checkbox', { name: 'Show unchanged lines too' })).toBeNull();
  });

  it('says identical texts are identical in the word view too', async () => {
    const user = await opened();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Compare by' }), 'words');
    await setText('Changed', 'The quick brown fox\njumps over\nthe lazy dog.\n');
    await waitFor(() => {
      expect(statusText()).toBe('The texts are identical.');
    });
    expect(document.querySelector('p.flow')).toBeNull();
  });

  it('ignores white space on request', async () => {
    const user = await opened();
    await setText('Original', 'a  b\nc');
    await setText('Changed', 'a b\n  c');
    await waitFor(() => {
      expect(statusText()).toBe('Lines: 2 added, 2 removed.');
    });
    await user.click(screen.getByRole('checkbox', { name: 'Ignore white space' }));
    await waitFor(() => {
      expect(statusText()).toBe('The texts are identical.');
    });
    expect(pool.jobs.at(-1)).toMatchObject({ ignoreWhitespace: true });
  });
});

describe('limits and failures', () => {
  it('refuses a text over the limit and does not start a job for it', async () => {
    await opened();
    const jobs = pool.jobs.length;
    await setText('Original', 'x'.repeat(201));
    await waitFor(() => {
      expect(fieldErrorText()).toBe('This text is longer than 200 characters.');
    });
    expect(field('Original').getAttribute('aria-invalid')).toBe('true');
    expect(table()).toBeNull();
    expect(statusText()).toBe('');
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(pool.jobs).toHaveLength(jobs);
    await setText('Original', 'x'.repeat(200));
    await waitFor(() => {
      expect(statusText()).not.toBe('');
    });
    expect(fieldErrorText()).toBeNull();
  });

  it('is stopped after the time limit, and the page says why', async () => {
    await opened();
    pool.behaviour = 'hang';
    await setText('Original', 'slow');
    await waitFor(() => {
      expect(alertText()).toBe('Stopped after 0.4 seconds. Compare shorter texts.');
    });
    expect(table()).toBeNull();
    expect(statusText()).toBe('');
    pool.behaviour = 'real';
    await setText('Original', 'fast');
    await waitFor(() => {
      expect(alertText()).toBe('');
    });
    await ready();
  });

  it('reports a failure of the worker, which is not a timeout', async () => {
    await opened();
    pool.behaviour = 'fail';
    await setText('Original', 'broken');
    await waitFor(() => {
      expect(alertText()).toBe('The comparison could not be run. Change a text and try again.');
    });
  });

  it('drops the answer of a comparison that finishes after the texts became too long', async () => {
    await opened();
    pool.behaviour = 'late';
    await setText('Original', 'late');
    await waitFor(() => {
      expect(pool.release).toBeDefined();
    });
    await setText('Original', 'x'.repeat(300));
    pool.release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(table()).toBeNull();
    expect(statusText()).toBe('');
  });

  it('drops a job that a newer edit replaced, without an error', async () => {
    await opened();
    pool.behaviour = 'hang';
    await setText('Original', 'one');
    await waitFor(() => {
      expect(pool.jobs.at(-1)).toMatchObject({ before: 'one' });
    });
    pool.behaviour = 'real';
    await setText('Original', 'two');
    await waitFor(() => {
      expect(pool.jobs.at(-1)).toMatchObject({ before: 'two' });
    });
    await ready();
    expect(alertText()).toBe('');
    expect(pool.created).toBe(1);
  });

  it('says when the texts could not be lined up in time, and when rows were cut off', async () => {
    await opened();
    const rows = Array.from({ length: 6 }, (_, index) => ({
      kind: 'added' as const,
      after: index + 1,
      right: [{ text: `line ${String(index)}`, kind: 'added' as const }],
    }));
    pool.override = {
      unit: 'lines',
      rows,
      stats: { added: 9, removed: 0, unchanged: 0 },
      truncated: true,
      degraded: true,
    } satisfies Output;
    await setText('Original', 'trigger');
    await waitFor(() => {
      expect(screen.getByText(/share too little to be lined up/)).toBeTruthy();
    });
    expect(screen.getByText('Only the first 6 rows are shown.')).toBeTruthy();
    expect(bodyRows()).toHaveLength(6);
    pool.override = {
      unit: 'words',
      segments: [{ text: 'all', kind: 'added' }],
      stats: { added: 1, removed: 0, unchanged: 0 },
      degraded: true,
    } satisfies Output;
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Compare by' }), 'words');
    await waitFor(() => {
      expect(screen.getByText(/share too little to be lined up/)).toBeTruthy();
    });
  });

  it('stops the worker when the page goes away', async () => {
    const view = await openTool(manifest);
    await ready();
    expect(pool.created).toBe(1);
    view.router.navigate('/');
    await waitFor(() => {
      expect(pool.terminated).toBe(1);
    });
  });
});

describe('diff in German', () => {
  it('shows German texts', async () => {
    await opened();
    i18n.setLocale('de');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Text-Vergleich');
    });
    expect(screen.getByRole('combobox', { name: 'Vergleichen nach' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Geändert' })).toBeTruthy();
  });
});
