import { cleanup, fireEvent, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import { MAX_INPUT_CHARS, runTask, type Input } from '../../src/tools/json-yaml-xml/convert.ts';
import manifest from '../../src/tools/json-yaml-xml/manifest.ts';
import { openTool } from '../tool-helpers.ts';

type User = ReturnType<typeof userEvent.setup>;

const pool = vi.hoisted(() => ({
  behaviour: 'real',
  release: undefined as (() => void) | undefined,
  created: 0,
  terminated: 0,
  jobs: [] as unknown[],
  run: undefined as unknown as (input: unknown, options: unknown) => Promise<unknown>,
}));

vi.mock('../../src/tools/json-yaml-xml/pool.ts', () => ({
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

const work = { progress: (): void => undefined };

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
          resolve(runTask(input as Input, work));
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
    return Promise.resolve(runTask(input as Input, work));
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  i18n.setLocale('en');
});

function field(name: string): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name });
}

function input(): HTMLTextAreaElement {
  return field('Input');
}

function result(): string | undefined {
  return screen.queryByRole<HTMLTextAreaElement>('textbox', { name: 'Result' })?.value;
}

function statuses(): string {
  return [...document.querySelectorAll('main .tool-status')]
    .map((region) => region.textContent.trim())
    .filter((line) => line !== '')
    .join('|');
}

async function paste(user: User, value: string): Promise<void> {
  await user.clear(input());
  await user.click(input());
  await user.paste(value);
}

describe('json-yaml-xml', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
    expect(manifest.requires).toContain('worker');
  });

  it('opens at /tools/json-yaml-xml with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/json-yaml-xml');
    expect(view.headings).toEqual(['JSON, YAML and XML converter']);
    expect(view.searchHits('yml')).toEqual(['json-yaml-xml']);
    expect(view.searchHits('umwandeln')).toEqual(['json-yaml-xml']);
  });

  it('converts the example from JSON to YAML in the worker and announces it', async () => {
    await openTool(manifest);
    await waitFor(() => {
      expect(result()).toBe(
        'name: stuffcloud\ntags:\n  - json\n  - yaml\n  - xml\nnested:\n  ok: true\n  count: 3\n',
      );
    });
    expect(statuses()).toBe('Converted from JSON to YAML.');
    expect(pool.created).toBe(1);
  });

  it('converts to XML, with its own options, root name and declaration', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Convert to' }), 'xml');
    await waitFor(() => {
      expect(result()).toContain(
        '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <name>stuffcloud</name>',
      );
    });
    expect(screen.getByText(/XML is read without DTDs/)).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Write the XML declaration' }));
    await waitFor(() => {
      expect(result()?.startsWith('<root>')).toBe(true);
    });
    const root = screen.getByRole('textbox', { name: 'Name of the XML root element' });
    await user.clear(root);
    await user.click(root);
    await user.paste('data');
    await waitFor(() => {
      expect(result()?.startsWith('<data>')).toBe(true);
    });
  });

  it('marks a root name that is no XML name, and uses the default instead', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Convert to' }), 'xml');
    const root = screen.getByRole('textbox', { name: 'Name of the XML root element' });
    await user.clear(root);
    await user.click(root);
    await user.paste('not a name');
    expect(screen.getByText('This is not a valid XML element name.')).toBeTruthy();
    expect(root.getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => {
      expect(result()).toContain('<root>');
    });
  });

  it('indents with four spaces, a tab, or not at all, and sorts keys', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Convert to' }), 'json');
    await paste(user, '{"b":1,"a":{"d":1}}');
    const indent = screen.getByRole('combobox', { name: 'Indentation' });
    await user.selectOptions(indent, '4');
    await waitFor(() => {
      expect(result()).toBe('{\n    "b": 1,\n    "a": {\n        "d": 1\n    }\n}');
    });
    await user.selectOptions(indent, 'tab');
    await waitFor(() => {
      expect(result()).toBe('{\n\t"b": 1,\n\t"a": {\n\t\t"d": 1\n\t}\n}');
    });
    await user.selectOptions(indent, 'min');
    await user.click(screen.getByRole('checkbox', { name: 'Sort the keys' }));
    await waitFor(() => {
      expect(result()).toBe('{"a":{"d":1},"b":1}');
    });
  });

  it('says where the input is wrong, in which format, and shows no result', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, '{\n  "a": 1\n  "b": 2\n}');
    await waitFor(() => {
      expect(statuses()).toBe(
        'JSON input: Unexpected “"”. Expected a comma or the closing brace. (line 3, column 3)',
      );
    });
    expect(result()).toBeUndefined();
    expect(document.querySelector('main .tool-status.alert')?.getAttribute('role')).toBe('alert');
  });

  it('says what cannot be written, with the place', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Convert to' }), 'xml');
    await paste(user, '{"a":{"b c":1}}');
    await waitFor(() => {
      expect(statuses()).toBe(
        'This cannot be written as XML: “b c” is not a valid XML element or attribute name (at $.a["b c"]). Rename the key.',
      );
    });
  });

  it('reads XML, with numbers as numbers only when asked', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Convert from' }), 'xml');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Convert to' }), 'json');
    await paste(user, '<r><n>1</n><t>true</t></r>');
    await waitFor(() => {
      expect(result()).toBe('{\n  "r": {\n    "n": "1",\n    "t": "true"\n  }\n}');
    });
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Read numbers and true or false in XML as such, not as text',
      }),
    );
    await waitFor(() => {
      expect(result()).toBe('{\n  "r": {\n    "n": 1,\n    "t": true\n  }\n}');
    });
  });

  it('swaps the formats and takes the result as the input', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await waitFor(() => {
      expect(result()).toBeDefined();
    });
    const before = result() ?? '';
    await user.click(
      screen.getByRole('button', { name: 'Swap formats and use the result as the input' }),
    );
    expect(input().value).toBe(before);
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Convert from' }).value).toBe(
      'yaml',
    );
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Convert to' }).value).toBe(
      'json',
    );
    await waitFor(() => {
      expect(JSON.parse(result() ?? '{}')).toMatchObject({ name: 'stuffcloud' });
    });
  });

  it('swaps the formats even when there is no result to take over', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, '{');
    await waitFor(() => {
      expect(result()).toBeUndefined();
    });
    await user.click(
      screen.getByRole('button', { name: 'Swap formats and use the result as the input' }),
    );
    expect(input().value).toBe('{');
  });

  it('tells about numbers it had to round and nulls it wrote as empty elements', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, '{"a":12345678901234567890}');
    await waitFor(() => {
      expect(document.querySelector('.notes')?.textContent).toContain(
        '1 number has more digits than a JavaScript number can hold and was rounded.',
      );
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Convert to' }), 'xml');
    await paste(user, '{"a":null,"b":null}');
    await waitFor(() => {
      expect(document.querySelector('.notes')?.textContent).toContain(
        '2 nulls were written as empty elements',
      );
    });
  });

  it('copies and downloads the result', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await waitFor(() => {
      expect(result()).toBeDefined();
    });
    await user.click(screen.getByRole('button', { name: 'Copy result' }));
    expect(await navigator.clipboard.readText()).toBe(result());
    const create = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: 'Download result' }));
    expect(create).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
  });

  it('refuses a text that is too long without sending it to the worker', async () => {
    await openTool(manifest);
    await waitFor(() => {
      expect(result()).toBeDefined();
    });
    pool.jobs = [];
    await fireEvent.input(input(), { target: { value: ' '.repeat(MAX_INPUT_CHARS + 1) } });
    await waitFor(() => {
      expect(statuses()).toBe('The text is longer than 5,000,000 characters.');
    });
    expect(result()).toBeUndefined();
    expect(pool.jobs).toEqual([]);
  });

  it('says so when the worker fails', async () => {
    pool.behaviour = 'fail';
    await openTool(manifest);
    await waitFor(() => {
      expect(statuses()).toBe('The conversion failed.');
    });
    expect(result()).toBeUndefined();
  });

  it('stops a conversion that takes too long, and works on afterwards', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    pool.behaviour = 'hang';
    await openTool(manifest);
    await vi.advanceTimersByTimeAsync(300);
    expect(pool.jobs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_500);
    await waitFor(() => {
      expect(statuses()).toBe(
        'Stopped after 10 seconds: this document is too complex to convert here.',
      );
    });
    pool.behaviour = 'real';
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await paste(user, '{"a":1}');
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => {
      expect(result()).toBe('a: 1\n');
    });
  });

  it('drops an answer that arrives after a newer edit', async () => {
    const user = userEvent.setup();
    pool.behaviour = 'late';
    await openTool(manifest);
    await waitFor(() => {
      expect(pool.release).toBeDefined();
    });
    const first = pool.release as (() => void) | undefined;
    pool.release = undefined;
    await paste(user, '{"b":2}');
    await waitFor(() => {
      expect(pool.release).toBeDefined();
    });
    const second = pool.release as (() => void) | undefined;
    second?.();
    await waitFor(() => {
      expect(result()).toBe('b: 2\n');
    });
    first?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result()).toBe('b: 2\n');
  });

  it('ends its worker when the page goes away', async () => {
    await openTool(manifest);
    await waitFor(() => {
      expect(result()).toBeDefined();
    });
    cleanup();
    expect(pool.terminated).toBe(1);
  });

  it('speaks German', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    i18n.setLocale('de');
    const german = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Eingabe' });
    await user.clear(german);
    await user.click(german);
    await user.paste('[1,');
    await waitFor(() => {
      expect(statuses()).toBe(
        'Eingabe als JSON: Der Text endet zu früh. Erwartet wurde ein Wert. (Zeile 1, Spalte 4)',
      );
    });
  });
});
