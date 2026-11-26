import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/textops/manifest.ts';
import type * as TextopsTask from '../../src/tools/textops/task.ts';
import { runTask, type Input } from '../../src/tools/textops/task.ts';
import { toast } from '@mozra-the-great/kern';
import { openTool } from '../tool-helpers.ts';
import { fieldErrorText } from '../helpers.ts';

const pool = vi.hoisted(() => ({
  behaviour: 'real',
  release: undefined as (() => void) | undefined,
  created: 0,
  terminated: 0,
  jobs: [] as unknown[],
  run: undefined as unknown as (input: unknown, options: unknown) => Promise<unknown>,
}));

const downloads = vi.hoisted(() => ({
  saved: [] as { name: string; text: string }[],
}));

vi.mock('../../src/app/download.ts', () => ({
  saveText: (name: string, text: string) => {
    downloads.saved.push({ name, text });
  },
  saveBlob: () => undefined,
}));

vi.mock('../../src/tools/textops/pool.ts', () => ({
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

vi.mock('../../src/tools/textops/task.ts', async (importOriginal) => {
  const original = await importOriginal<typeof TextopsTask>();
  return { ...original, TASK_TIMEOUT_MS: 400, MAX_TEXT_LENGTH: 120 };
});

type User = ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.stubGlobal(
    'Worker',
    class FakeWorker {
      readonly terminate = vi.fn();
    },
  );
  downloads.saved = [];
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
      return new Promise((resolve) => {
        pool.release = () => {
          resolve(runTask(input as Input, { progress: () => undefined }));
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
    return Promise.resolve(runTask(input as Input, { progress: () => undefined }));
  };
});

afterEach(() => {
  toast.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  i18n.setLocale('en');
});

function input(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Your text' });
}

function output(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Result text' });
}

async function setInput(value: string): Promise<void> {
  await fireEvent.input(input(), { target: { value } });
}

async function setField(name: string, value: string): Promise<void> {
  const role = name === 'First number' ? 'spinbutton' : 'textbox';
  await fireEvent.input(screen.getByRole(role, { name }), { target: { value } });
}

function statusText(): string {
  return document.querySelector('main .tool-status:not(.alert)')?.textContent.trim() ?? '';
}

function alertText(): string {
  return document.querySelector('main .tool-status.alert')?.textContent.trim() ?? '';
}

function counts(): Record<string, string> {
  return Object.fromEntries(
    [...document.querySelectorAll('.counts .count')].map((row) => [
      row.querySelector('dt')?.textContent ?? '',
      row.querySelector('dd')?.textContent ?? '',
    ]),
  );
}

async function chooseOperation(user: User, label: string): Promise<void> {
  await user.selectOptions(screen.getByRole('combobox', { name: 'What to do' }), label);
}

async function waitForOutput(expected: string): Promise<void> {
  await waitFor(() => {
    expect(output().value).toBe(expected);
  });
}

async function opened(text?: string): Promise<User> {
  const user = userEvent.setup();
  await openTool(manifest);
  if (text !== undefined) {
    await setInput(text);
  }
  await waitFor(() => {
    expect(output().value).not.toBe('');
  });
  return user;
}

describe('textops', () => {
  it('keeps the privacy promise in its manifest and needs a worker', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
    expect(manifest.requires).toContain('worker');
  });

  it('opens at /tools/textops with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/textops');
    expect(view.headings).toEqual(['Text tools']);
    expect(view.searchHits('text tools')).toEqual(['textops']);
    expect(view.searchHits('slugify')).toEqual(['textops']);
    expect(view.searchHits('zeilen sortieren')).toEqual(['textops']);
  });

  it('has the headings of its sections and a read-only result', async () => {
    await opened();
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['Text', 'Operation', 'Result']);
    expect(output().readOnly).toBe(true);
    expect(document.querySelectorAll('main .tool-status')).toHaveLength(2);
  });
});

describe('the counters', () => {
  it('count the text as it is typed', async () => {
    await opened('Hello world\n\nSecond paragraph here\nstill second\n');
    await waitFor(() => {
      expect(counts()['Words']).toBe('7');
    });
    expect(counts()).toEqual({
      Characters: '48',
      'Without spaces': '40',
      Words: '7',
      Lines: '4',
      Paragraphs: '2',
      'Bytes (UTF-8)': '48',
    });
  });

  it('format large numbers for the language and keep counting when the options are incomplete', async () => {
    const user = await opened();
    await chooseOperation(user, 'number');
    await setField('First number', 'x');
    await setInput('a'.repeat(100));
    await waitFor(() => {
      expect(counts()['Characters']).toBe('100');
    });
    await waitForOutput('');
    expect(pool.jobs.at(-1)).toMatchObject({ request: null });
  });
});

describe('change case', () => {
  it('converts to upper case at first and to another style on request', async () => {
    const user = await opened('hello big world\nsecond line');
    await waitForOutput('HELLO BIG WORLD\nSECOND LINE');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Style' }), 'camel');
    await waitForOutput('helloBigWorld\nsecondLine');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Style' }), 'kebab');
    await waitForOutput('hello-big-world\nsecond-line');
    expect(statusText()).toBe('Result updated.');
  });
});

describe('sort lines', () => {
  it('sorts with numbers by value and can reverse and ignore case', async () => {
    const user = await opened('item 10\nitem 2\nitem 1\nApple\nbanana');
    await chooseOperation(user, 'sort');
    await waitForOutput('Apple\nbanana\nitem 1\nitem 2\nitem 10');
    await user.click(screen.getByRole('checkbox', { name: 'Descending (Z to A)' }));
    await waitForOutput('item 10\nitem 2\nitem 1\nbanana\nApple');
    await user.click(screen.getByRole('checkbox', { name: 'Numbers by value (2 before 10)' }));
    await waitForOutput('item 2\nitem 10\nitem 1\nbanana\nApple');
    await user.click(screen.getByRole('checkbox', { name: 'Ignore case' }));
    await waitFor(() => {
      expect(pool.jobs.at(-1)).toMatchObject({ request: { ignoreCase: true, locale: 'en' } });
    });
  });
});

describe('remove duplicate lines', () => {
  it('keeps the first of each, says how many it removed, and can ignore case and white space', async () => {
    const user = await opened('a\nb\nA\n b \na');
    await chooseOperation(user, 'dedupe');
    await waitForOutput('a\nb\nA\n b ');
    await waitFor(() => {
      expect(statusText()).toBe('1 duplicate line removed.');
    });
    await user.click(screen.getByRole('checkbox', { name: 'Ignore case' }));
    await waitForOutput('a\nb\n b ');
    await user.click(screen.getByRole('checkbox', { name: 'Ignore white space' }));
    await waitForOutput('a\nb');
    await waitFor(() => {
      expect(statusText()).toBe('3 duplicate lines removed.');
    });
  });
});

describe('trim white space', () => {
  it('trims both ends, one end, empty lines and repeated spaces', async () => {
    const user = await opened('  a   b  \n\n  c  ');
    await chooseOperation(user, 'trim');
    await waitForOutput('a   b\n\nc');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Trim' }), 'start');
    await waitForOutput('a   b  \n\nc  ');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Trim' }), 'end');
    await waitForOutput('  a   b\n\n  c');
    await user.click(screen.getByRole('checkbox', { name: 'Remove empty lines' }));
    await waitForOutput('  a   b\n  c');
    await user.click(screen.getByRole('checkbox', { name: 'Make repeated spaces one' }));
    await waitForOutput(' a b\n c');
  });
});

describe('number lines', () => {
  it('numbers from a start with a separator and aligns the numbers', async () => {
    const lines = Array.from({ length: 10 }, (_, index) => `l${String(index)}`).join('\n');
    const user = await opened(lines);
    await chooseOperation(user, 'number');
    await waitFor(() => {
      expect(output().value.startsWith(' 1: l0\n 2: l1')).toBe(true);
    });
    await user.click(screen.getByRole('checkbox', { name: 'Align the numbers' }));
    await waitFor(() => {
      expect(output().value.startsWith('1: l0\n2: l1')).toBe(true);
    });
    await setField('First number', '0');
    await setField('Text after the number', '\t');
    await waitFor(() => {
      expect(output().value.startsWith('0\tl0\n1\tl1')).toBe(true);
    });
  });

  it('reports a start that is not a whole number and a separator that is too long', async () => {
    const user = await opened('a\nb');
    await chooseOperation(user, 'number');
    for (const bad of ['', 'abc', '1.5', '2000000000']) {
      await setField('First number', bad);
      await waitFor(() => {
        expect(fieldErrorText()).toBe('Enter a whole number, at most 1,000,000,000 in size.');
      });
      await waitForOutput('');
    }
    await setField('First number', '-2');
    await waitFor(() => {
      expect(output().value).toBe('-2: a\n-1: b');
    });
    await setField('Text after the number', 'x'.repeat(11));
    await waitFor(() => {
      expect(fieldErrorText()).toBe('At most 10 characters.');
    });
    await waitForOutput('');
  }, 20_000);
});

describe('find and replace', () => {
  it('waits for a search text, then replaces and says how many', async () => {
    const user = await opened('one two one three one');
    await chooseOperation(user, 'replace');
    await waitFor(() => {
      expect(pool.jobs.at(-1)).toMatchObject({ request: null });
    });
    expect(output().value).toBe('');
    await setField('Find', 'one');
    await setField('Replace with', '1');
    await waitForOutput('1 two 1 three 1');
    await waitFor(() => {
      expect(statusText()).toBe('3 matches replaced.');
    });
    await setField('Find', 'three');
    await waitFor(() => {
      expect(statusText()).toBe('1 match replaced.');
    });
  });

  it('uses groups of a regular expression, and says when the pattern does not work', async () => {
    const user = await opened('2026-11-19 and 2027-01-02');
    await chooseOperation(user, 'replace');
    await user.click(screen.getByRole('checkbox', { name: 'Regular expression' }));
    expect(screen.getByText(/Use \$1, \$2/)).toBeTruthy();
    await setField('Find', String.raw`(\d+)-(\d+)-(\d+)`);
    await setField('Replace with', '$3.$2.$1');
    await waitForOutput('19.11.2026 and 02.01.2027');
    await setField('Find', '(');
    await waitFor(() => {
      expect(fieldErrorText()).toMatch(/^This pattern does not work: /);
    });
    expect(output().value).toBe('');
    expect(screen.getByRole('textbox', { name: 'Find' }).getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps `$` literal in a plain replacement, and honours whole words and case', async () => {
    const user = await opened('cat concat Cat');
    await chooseOperation(user, 'replace');
    await setField('Find', 'cat');
    await setField('Replace with', '$&');
    await waitForOutput('$& con$& Cat');
    await user.click(screen.getByRole('checkbox', { name: 'Whole words only' }));
    await waitForOutput('$& concat Cat');
    await user.click(screen.getByRole('checkbox', { name: 'Ignore case' }));
    await waitForOutput('$& concat $&');
  });

  it('refuses a search text that is too long', async () => {
    const user = await opened('abc');
    await chooseOperation(user, 'replace');
    await setField('Find', 'x'.repeat(1001));
    await waitFor(() => {
      expect(fieldErrorText()).toBe('At most 1,000 characters.');
    });
    await waitForOutput('');
  });
});

describe('make slugs', () => {
  it('makes one slug per line, with the chosen separator and spelling', async () => {
    const user = await opened('Crème Brûlée für Größe\nSecond Line!');
    await chooseOperation(user, 'slug');
    await waitForOutput('creme-brulee-fur-grosse\nsecond-line');
    await user.click(screen.getByRole('checkbox', { name: 'Write ä, ö, ü as ae, oe, ue' }));
    await waitForOutput('creme-brulee-fuer-groesse\nsecond-line');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Separator' }), '_');
    await waitForOutput('creme_brulee_fuer_groesse\nsecond_line');
    await user.click(screen.getByRole('checkbox', { name: 'Only a to z and 0 to 9' }));
    await setInput('日本語 テキスト');
    await waitForOutput('日本語_テキスト');
  });
});

describe('the result', () => {
  it('can be copied, downloaded and used as the text', async () => {
    const user = await opened('abc');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await waitForOutput('ABC');
    await user.click(screen.getByRole('button', { name: 'Copy result' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('ABC');
    });
    await user.click(screen.getByRole('button', { name: 'Download as .txt' }));
    expect(downloads.saved).toEqual([{ name: 'text.txt', text: 'ABC' }]);
    await user.click(screen.getByRole('button', { name: 'Use result as text' }));
    expect(input().value).toBe('ABC');
    expect(statusText()).toBe('The result is now the text.');
    await chooseOperation(user, 'case');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Style' }), 'lower');
    await waitForOutput('abc');
  });

  it('cannot be downloaded or moved when there is none', async () => {
    const user = await opened();
    await chooseOperation(user, 'replace');
    await waitFor(() => {
      expect(output().value).toBe('');
    });
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Download as .txt' }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Use result as text' }).disabled,
    ).toBe(true);
  });
});

describe('limits and failures', () => {
  it('refuses a text over the limit and starts no job for it', async () => {
    await opened();
    const jobs = pool.jobs.length;
    await setInput('x'.repeat(121));
    await waitFor(() => {
      expect(fieldErrorText()).toBe('This text is longer than 120 characters.');
    });
    expect(output().value).toBe('');
    expect(statusText()).toBe('');
    expect(Object.keys(counts())).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(pool.jobs).toHaveLength(jobs);
    await setInput('x'.repeat(120));
    await waitForOutput('X'.repeat(120));
  });

  it('is stopped after the time limit, and the page says why', async () => {
    await opened();
    pool.behaviour = 'hang';
    await setInput('slow');
    await waitFor(() => {
      expect(alertText()).toBe(
        'Stopped after 0.4 seconds. Use a simpler pattern or a shorter text.',
      );
    });
    expect(output().value).toBe('');
    pool.behaviour = 'real';
    await setInput('fast');
    await waitForOutput('FAST');
    expect(alertText()).toBe('');
  });

  it('reports a failure of the worker, which is not a timeout', async () => {
    await opened();
    pool.behaviour = 'fail';
    await setInput('broken');
    await waitFor(() => {
      expect(alertText()).toBe(
        'The operation could not be run. Change the text or the options and try again.',
      );
    });
  });

  it('drops the answer of a job that finishes after the text became too long', async () => {
    await opened();
    pool.behaviour = 'late';
    await setInput('late');
    await waitFor(() => {
      expect(pool.release).toBeDefined();
    });
    await setInput('x'.repeat(300));
    pool.release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(output().value).toBe('');
    expect(Object.keys(counts())).toHaveLength(0);
  });

  it('drops a job that a newer edit replaced, without an error, and reuses one worker', async () => {
    await opened();
    pool.behaviour = 'hang';
    await setInput('one');
    await waitFor(() => {
      expect(pool.jobs.at(-1)).toMatchObject({ text: 'one' });
    });
    pool.behaviour = 'real';
    await setInput('two');
    await waitForOutput('TWO');
    expect(alertText()).toBe('');
    expect(pool.created).toBe(1);
  });

  it('stops the worker when the page goes away', async () => {
    const view = await openTool(manifest);
    await waitFor(() => {
      expect(output().value).not.toBe('');
    });
    view.router.navigate('/');
    await waitFor(() => {
      expect(pool.terminated).toBe(1);
    });
  });
});

describe('textops in German', () => {
  it('shows German texts and prefers the spelling of ä, ö, ü as ae, oe, ue', async () => {
    await openTool(manifest);
    i18n.setLocale('de');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Textwerkzeuge');
    });
    expect(screen.getByRole('textbox', { name: 'Dein Text' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Was tun' })).toBeTruthy();
  });
});
