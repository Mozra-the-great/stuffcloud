import { cleanup, fireEvent, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import { MAX_FILE_BYTES, MAX_TEXT_CHARS } from '../../src/tools/base64/codec.ts';
import manifest from '../../src/tools/base64/manifest.ts';
import { runTask, type Input } from '../../src/tools/base64/task.ts';
import { openTool } from '../tool-helpers.ts';

type User = ReturnType<typeof userEvent.setup>;

const pool = vi.hoisted(() => ({
  behaviour: 'real',
  created: 0,
  terminated: 0,
  jobs: [] as unknown[],
  run: undefined as unknown as (input: unknown, options: unknown) => Promise<unknown>,
}));

vi.mock('../../src/tools/base64/pool.ts', () => ({
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
  pool.jobs = [];
  pool.run = (input, options) => {
    pool.jobs.push(input);
    const { signal, onProgress } = options as {
      signal: AbortSignal;
      onProgress: (progress: { completed: number; total: number }) => void;
    };
    if (pool.behaviour === 'fail') {
      return Promise.reject(new Error('boom'));
    }
    if (pool.behaviour === 'hang') {
      onProgress({ completed: 3, total: 10 });
      return new Promise((_resolve, reject) => {
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  i18n.setLocale('en');
});

function statuses(): string {
  return [...document.querySelectorAll('main .tool-status')]
    .map((region) => region.textContent.trim())
    .filter((line) => line !== '')
    .join('|');
}

function area(name: string): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name });
}

function result(): string | undefined {
  return screen.queryByRole<HTMLTextAreaElement>('textbox', { name: 'Result' })?.value;
}

async function paste(user: User, label: string, value: string): Promise<void> {
  const field = area(label);
  await user.clear(field);
  await user.click(field);
  await user.paste(value);
}

async function choose(user: User, name: string, value: string): Promise<void> {
  await user.selectOptions(screen.getByRole('combobox', { name }), value);
}

function pickFile(file: File): Promise<void> {
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (picker === null) {
    throw new Error('no file picker');
  }
  return userEvent.setup().upload(picker, file);
}

describe('base64', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/base64 with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/base64');
    expect(view.headings).toEqual(['Base64 encoder and decoder']);
    expect(view.searchHits('data uri')).toEqual(['base64']);
    expect(view.searchHits('kodieren')).toEqual(['base64']);
  });
});

describe('text', () => {
  it('encodes the example at once and announces it', async () => {
    await openTool(manifest);
    expect(result()).toBe('SGVsbG8sIHN0dWZmY2xvdWQh');
    await waitFor(() => {
      expect(statuses()).toBe('Encoded 18 bytes into 24 characters.');
    });
  });

  it('encodes as UTF-8, with the URL-safe alphabet, without padding, in lines', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, 'Text to encode', 'ä€😀>>');
    expect(result()).toBe(Buffer.from('ä€😀>>').toString('base64'));
    await user.click(
      screen.getByRole('checkbox', { name: 'URL-safe alphabet (- and _ instead of + and /)' }),
    );
    expect(result()).toBe(Buffer.from('ä€😀>>').toString('base64url') + '=');
    await user.click(screen.getByRole('checkbox', { name: 'Add = padding' }));
    expect(result()).toBe(Buffer.from('ä€😀>>').toString('base64url'));
    await paste(user, 'Text to encode', 'x'.repeat(100));
    await choose(user, 'Line breaks', '76');
    expect(
      result()
        ?.split('\n')
        .map((line) => line.length),
    ).toEqual([76, 58]);
    await choose(user, 'Line breaks', '64');
    expect(
      result()
        ?.split('\n')
        .map((line) => line.length),
    ).toEqual([64, 64, 6]);
  });

  it('writes a data URI, with the standard alphabet and padding, and checks the media type', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, 'Text to encode', 'hi?>');
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Write as a data URI (standard alphabet, with padding)',
      }),
    );
    expect(screen.queryByRole('checkbox', { name: 'Add = padding' })).toBeNull();
    expect(result()).toBe('data:text/plain;charset=utf-8;base64,aGk/Pg==');
    const type = screen.getByRole('textbox', { name: 'Media type of the data URI' });
    await user.clear(type);
    await user.click(type);
    await user.paste('not a type');
    expect(screen.getByText('This is not a valid media type, such as text/plain.')).toBeTruthy();
    expect(result()).toBe('aGk/Pg==');
    await user.clear(type);
    await user.click(type);
    await user.paste('text/markdown');
    expect(result()).toBe('data:text/markdown;base64,aGk/Pg==');
  });

  it('shows nothing for an empty text', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await user.clear(area('Text to encode'));
    expect(result()).toBeUndefined();
  });

  it('decodes text, in either alphabet, and copies it', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await choose(user, 'Direction', 'decode');
    await paste(user, 'Base64 to decode', 'SGVsbG8s\nIHN0dWZm Y2xvdWQh');
    expect(area('Decoded text').value).toBe('Hello, stuffcloud!');
    await waitFor(() => {
      expect(statuses()).toBe('Decoded 18 bytes as text.');
    });
    await user.click(screen.getByRole('button', { name: 'Copy result' }));
    expect(await navigator.clipboard.readText()).toBe('Hello, stuffcloud!');
    await paste(user, 'Base64 to decode', '-__-');
    expect(
      screen.getByText(
        /This is not text \(it is not valid UTF-8\)\. It is 3 bytes long\. The first bytes are fb ff fe\./,
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(statuses()).toBe('Decoded 3 bytes of binary data.');
    });
  });

  it('understands a data URI and says which type it names', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await choose(user, 'Direction', 'decode');
    await paste(user, 'Base64 to decode', 'data:text/plain;base64,aGk=');
    expect(area('Decoded text').value).toBe('hi');
    expect(screen.getByText('The data URI says the type is text/plain.')).toBeTruthy();
  });

  it('says where the Base64 is wrong', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await choose(user, 'Direction', 'decode');
    await paste(user, 'Base64 to decode', 'SGVs\nbG!v');
    await waitFor(() => {
      expect(statuses()).toBe('“!” is not a Base64 character. (line 2, column 3)');
    });
    expect(screen.queryByRole('textbox', { name: 'Decoded text' })).toBeNull();
    await paste(user, 'Base64 to decode', 'A');
    await waitFor(() => {
      expect(statuses()).toContain('The length is not valid for Base64');
    });
    await paste(user, 'Base64 to decode', '');
    await waitFor(() => {
      expect(statuses()).toBe('');
    });
  });

  it('downloads what it decoded, as a file with the right name', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await choose(user, 'Direction', 'decode');
    const create = vi.fn((blob: Blob) => `blob:${blob.type}`);
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    await paste(user, 'Base64 to decode', 'aGk=');
    await user.click(screen.getByRole('button', { name: 'Download the decoded file' }));
    await paste(user, 'Base64 to decode', '-__-');
    await user.click(screen.getByRole('button', { name: 'Download the decoded file' }));
    await paste(user, 'Base64 to decode', 'data:image/png;base64,iVBORw0KGgo=');
    await user.click(screen.getByRole('button', { name: 'Download the decoded file' }));
    expect(names).toEqual(['decoded.txt', 'decoded.bin', 'decoded.png']);
    expect(create.mock.calls.map(([blob]) => blob.type)).toEqual([
      'text/plain',
      'application/octet-stream',
      'image/png',
    ]);
  });

  it('downloads the encoded text', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: 'Download as a text file' }));
    expect(click).toHaveBeenCalledOnce();
  });

  it('refuses a text that is too long and says to use a file', async () => {
    await openTool(manifest);
    await fireEvent.input(area('Text to encode'), {
      target: { value: 'a'.repeat(MAX_TEXT_CHARS + 1) },
    });
    await waitFor(() => {
      expect(statuses()).toBe('The text is longer than 2,000,000 characters. Use a file instead.');
    });
    expect(result()).toBeUndefined();
  });

  it('shows the first part of a long result and says so, but copies all of it', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await fireEvent.input(area('Text to encode'), { target: { value: 'a'.repeat(30_000) } });
    expect(result()?.length).toBe(20_000);
    expect(
      screen.getByText(
        'Showing the first 20,000 of 40,000 characters. Copy and download use the whole result.',
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copy result' }));
    expect((await navigator.clipboard.readText()).length).toBe(40_000);
    await choose(user, 'Direction', 'decode');
    await fireEvent.input(area('Base64 to decode'), {
      target: { value: Buffer.from('b'.repeat(30_000)).toString('base64') },
    });
    expect(area('Decoded text').value.length).toBe(20_000);
    expect(
      screen.getByText(
        'Showing the first 20,000 of 30,000 characters. Copy and download use the whole result.',
      ),
    ).toBeTruthy();
  });
});

describe('files', () => {
  it('encodes a file in the worker, with progress, and shows its name and size', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await choose(user, 'Source', 'file');
    await pickFile(new File(['foobar'], 'notes.txt', { type: 'text/plain' }));
    await waitFor(() => {
      expect(result()).toBe('Zm9vYmFy');
    });
    expect(screen.getByText('notes.txt · 6 B')).toBeTruthy();
    await waitFor(() => {
      expect(statuses()).toBe('Encoded 6 bytes into 8 characters.');
    });
    expect(pool.created).toBe(1);
  });

  it('writes a data URI of a file with its own type, and encodes again when an option changes', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await choose(user, 'Source', 'file');
    await pickFile(new File([new Uint8Array([0xfb, 0xff])], 'a.png', { type: 'image/png' }));
    await waitFor(() => {
      expect(result()).toBe('+/8=');
    });
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Write as a data URI (standard alphabet, with padding)',
      }),
    );
    await waitFor(() => {
      expect(result()).toBe('data:image/png;base64,+/8=');
    });
    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Media type of the data URI' }).value,
    ).toBe('image/png');
    await pickFile(new File([new Uint8Array([1])], 'b.bin'));
    await waitFor(() => {
      expect(result()).toBe('data:application/octet-stream;base64,AQ==');
    });
  });

  it('decodes a file of Base64 text', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await choose(user, 'Direction', 'decode');
    await choose(user, 'Source', 'file');
    await pickFile(new File(['aGVsbG8='], 'b64.txt'));
    await waitFor(() => {
      expect(area('Decoded text').value).toBe('hello');
    });
    await waitFor(() => {
      expect(statuses()).toBe('Decoded 5 bytes as text.');
    });
  });

  it('says where a file of Base64 text is wrong', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await choose(user, 'Direction', 'decode');
    await choose(user, 'Source', 'file');
    await pickFile(new File(['aGVs\n*G8='], 'bad.txt'));
    await waitFor(() => {
      expect(statuses()).toBe('“*” is not a Base64 character. (line 2, column 1)');
    });
  });

  it('shows what it is doing and cancels on request', async () => {
    const user = userEvent.setup();
    pool.behaviour = 'hang';
    await openTool(manifest);
    await choose(user, 'Source', 'file');
    await pickFile(new File(['foobar'], 'big.txt'));
    const bar = await screen.findByRole('progressbar', { name: 'Working on big.txt' });
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(statuses()).toBe('Cancelled.');
    });
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('says so when the worker fails', async () => {
    const user = userEvent.setup();
    pool.behaviour = 'fail';
    await openTool(manifest);
    await choose(user, 'Source', 'file');
    await pickFile(new File(['x'], 'x.txt'));
    await waitFor(() => {
      expect(statuses()).toBe('The file could not be read.');
    });
  });

  it('refuses a file that is too large without sending it to the worker', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await choose(user, 'Source', 'file');
    const big = new File(['x'], 'huge.bin');
    Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 });
    await pickFile(big);
    await waitFor(() => {
      expect(statuses()).toBe('This file is larger than 50.3 MB.');
    });
    expect(pool.jobs).toEqual([]);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('forgets a result when the direction changes, and ends its worker with the page', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await choose(user, 'Source', 'file');
    await pickFile(new File(['foobar'], 'notes.txt'));
    await waitFor(() => {
      expect(result()).toBe('Zm9vYmFy');
    });
    await choose(user, 'Direction', 'decode');
    await waitFor(() => {
      expect(result()).toBeUndefined();
    });
    cleanup();
    expect(pool.terminated).toBe(1);
  });
});

describe('German', () => {
  it('speaks German, errors included', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    i18n.setLocale('de');
    await screen.findByRole('combobox', { name: 'Richtung' });
    await choose(user, 'Richtung', 'decode');
    await paste(user, 'Zu dekodierendes Base64', 'ab!d');
    await waitFor(() => {
      expect(statuses()).toBe('“!” ist kein Base64-Zeichen. (Zeile 1, Spalte 3)');
    });
  });
});
