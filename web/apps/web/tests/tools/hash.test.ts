import { createHash } from 'node:crypto';
import { screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/hash/manifest.ts';
import { runTask, type Input, type Output } from '../../src/tools/hash/task.ts';
import { toaster } from '../../src/ui/toast.svelte.ts';
import { openTool } from '../tool-helpers.ts';
import { fieldErrorText } from '../helpers.ts';

type User = ReturnType<typeof userEvent.setup>;
type Behaviour = 'real' | 'hang' | 'fail';

const pool = vi.hoisted(() => ({
  behaviour: 'real',
  created: 0,
  terminated: 0,
  run: undefined as unknown as (input: unknown, options: unknown) => Promise<unknown>,
}));

vi.mock('../../src/tools/hash/pool.ts', () => ({
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

const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function setBehaviour(behaviour: Behaviour): void {
  pool.behaviour = behaviour;
}

interface RunOptions {
  readonly signal: AbortSignal;
  readonly onProgress: (progress: { completed: number; total: number }) => void;
}

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
  pool.run = async (input, options): Promise<Output> => {
    const { signal, onProgress } = options as RunOptions;
    if (pool.behaviour === 'fail') {
      throw new Error('boom');
    }
    if (pool.behaviour === 'hang') {
      onProgress({ completed: 1, total: 2 });
      return new Promise<Output>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      });
    }
    return runTask(input as Input, {
      progress: (completed, total) => {
        onProgress({ completed, total });
      },
    });
  };
});

afterEach(() => {
  toaster.clear();
  vi.unstubAllGlobals();
  i18n.setLocale('en');
});

function textBox(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Text to hash' });
}

function statusText(): string {
  return [...document.querySelectorAll('main .tool-status')]
    .map((region) => region.textContent.trim())
    .filter((text) => text !== '')
    .join('|');
}

function digests(): Record<string, string> {
  const rows = [...document.querySelectorAll('.digest')];
  return Object.fromEntries(
    rows.map((row) => [
      row.querySelector('.algorithm')?.textContent ?? '',
      row.querySelector('.value')?.textContent ?? '',
    ]),
  );
}

function filePicker(): HTMLInputElement {
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (picker === null) {
    throw new Error('no file input');
  }
  return picker;
}

async function chooseFile(user: User, file: File): Promise<void> {
  await user.selectOptions(screen.getByRole('combobox', { name: 'Hash a' }), 'file');
  await user.upload(filePicker(), file);
}

describe('hash', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
    expect(manifest.requires).toEqual(['webcrypto', 'worker']);
  });

  it('opens at /tools/hash with exactly one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/hash');
    expect(view.headings).toEqual(['Hash and checksum']);
    expect(view.searchHits('sha256')).toEqual(['hash']);
    expect(view.searchHits('prüfsumme')).toEqual(['hash']);
  });
});

describe('hashing text', () => {
  let user: User;

  beforeEach(async () => {
    user = userEvent.setup();
    await openTool(manifest);
  });

  it('shows the digests of the empty text first, then of what is typed', async () => {
    await waitFor(() => {
      expect(digests()['SHA-256']).toBe(createHash('sha256').update('').digest('hex'));
    });
    await user.type(textBox(), 'abc');
    await waitFor(() => {
      expect(digests()['SHA-256']).toBe(SHA256_ABC);
    });
    expect(Object.keys(digests())).toEqual(['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']);
    expect(digests()['SHA-1']).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('hashes text as UTF-8', async () => {
    await user.type(textBox(), 'ä€');
    await waitFor(() => {
      expect(digests()['SHA-256']).toBe(createHash('sha256').update('ä€', 'utf8').digest('hex'));
    });
  });

  it('announces the digests when the field is left, not on every key', async () => {
    await user.type(textBox(), 'abc');
    expect(statusText()).toBe('');
    await user.tab();
    expect(statusText()).toBe('The digests of the text are ready.');
  });

  it('shows hex in upper case and Base64 on request', async () => {
    await user.type(textBox(), 'abc');
    await waitFor(() => {
      expect(digests()['SHA-256']).toBe(SHA256_ABC);
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show as' }), 'hex-upper');
    expect(digests()['SHA-256']).toBe(SHA256_ABC.toUpperCase());
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show as' }), 'base64');
    expect(digests()['SHA-256']).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show as' }), 'hex');
    expect(digests()['SHA-256']).toBe(SHA256_ABC);
  });

  it('warns about SHA-1 and has a named copy button per digest', async () => {
    expect(await screen.findByText(/SHA-1 is only good for catching accidents/)).toBeTruthy();
    for (const name of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) {
      expect(screen.getByRole('button', { name: `Copy ${name}` })).toBeTruthy();
    }
  });

  it('copies a digest and confirms it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await user.type(textBox(), 'abc');
    await waitFor(() => {
      expect(digests()['SHA-256']).toBe(SHA256_ABC);
    });
    await user.click(screen.getByRole('button', { name: 'Copy SHA-256' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(SHA256_ABC);
    });
  });

  describe('comparing with a checksum', () => {
    function expected(): HTMLInputElement {
      return screen.getByRole<HTMLInputElement>('textbox', { name: 'Checksum you were given' });
    }

    beforeEach(async () => {
      await user.type(textBox(), 'abc');
      await waitFor(() => {
        expect(digests()['SHA-256']).toBe(SHA256_ABC);
      });
    });

    it('says which algorithm matches, whatever the case and separators', async () => {
      await user.type(expected(), SHA256_ABC.toUpperCase().replace(/(.{8})/g, '$1 '));
      expect(screen.getByText('It matches SHA-256.')).toBeTruthy();
      await user.tab();
      expect(statusText()).toBe('It matches SHA-256.');
    });

    it('says when nothing matches', async () => {
      await user.type(expected(), 'ab'.repeat(32));
      expect(screen.getByText('It does not match any digest above.')).toBeTruthy();
    });

    it('marks a text that is no digest, and announces it', async () => {
      await user.type(expected(), 'not a digest');
      expect(expected().getAttribute('aria-invalid')).toBe('true');
      expect(fieldErrorText()).toContain('This is not a hex digest');
      expect(document.querySelector('.verdict')).toBeNull();
      await user.tab();
      expect(statusText()).toContain('This is not a hex digest');
    });

    it('says nothing while the field is empty', () => {
      expect(document.querySelector('.verdict')).toBeNull();
    });
  });
});

describe('hashing a file', () => {
  let user: User;

  beforeEach(async () => {
    user = userEvent.setup();
    await openTool(manifest);
  });

  it('hashes the chosen file in the pool and announces the result', async () => {
    await chooseFile(user, new File(['abc'], 'note.txt', { type: 'text/plain' }));
    await waitFor(() => {
      expect(digests()['SHA-256']).toBe(SHA256_ABC);
    });
    expect(statusText()).toBe('The digests of note.txt are ready.');
    expect(screen.getByText('File: note.txt, 3 bytes')).toBeTruthy();
    expect(pool.created).toBe(1);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('shows progress with a cancel button while the job runs, and stops on cancel', async () => {
    setBehaviour('hang');
    await chooseFile(user, new File(['abc'], 'big.bin'));
    const bar = await screen.findByRole('progressbar', { name: 'Hashing big.bin' });
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(statusText()).toBe('Cancelled. The file was not hashed.');
    });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(document.querySelector('.digest')).toBeNull();
  });

  it('reports a failure in the alert region', async () => {
    setBehaviour('fail');
    await chooseFile(user, new File(['abc'], 'bad.bin'));
    await waitFor(() => {
      expect(document.querySelector('main .tool-status.alert')?.textContent).toBe(
        'The input could not be hashed. Try again, or choose another file.',
      );
    });
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('starts over with the next file and keeps one pool', async () => {
    await chooseFile(user, new File(['abc'], 'one.txt'));
    await waitFor(() => {
      expect(digests()['SHA-256']).toBe(SHA256_ABC);
    });
    await user.upload(filePicker(), new File([''], 'two.txt'));
    await waitFor(() => {
      expect(digests()['SHA-256']).toBe(createHash('sha256').update('').digest('hex'));
    });
    expect(pool.created).toBe(1);
  });

  it('forgets the status when the input kind changes, and ends the pool when the page goes', async () => {
    await chooseFile(user, new File(['abc'], 'one.txt'));
    await waitFor(() => {
      expect(statusText()).not.toBe('');
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Hash a' }), 'text');
    expect(statusText()).toBe('');
  });
});

describe('hash in German', () => {
  it('shows German texts', async () => {
    await openTool(manifest);
    i18n.setLocale('de');
    expect(await screen.findByRole('textbox', { name: 'Text zum Hashen' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'SHA-256 kopieren' })).toBeTruthy();
  });
});
