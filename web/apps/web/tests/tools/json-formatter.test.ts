import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/json-formatter/manifest.ts';
import { openTool } from '../tool-helpers.ts';

type User = ReturnType<typeof userEvent.setup>;

afterEach(() => {
  vi.restoreAllMocks();
  i18n.setLocale('en');
});

function input(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'JSON' });
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

describe('json-formatter', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/json-formatter with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/json-formatter');
    expect(view.headings).toEqual(['JSON formatter and validator']);
    expect(view.searchHits('beautify')).toEqual(['json-formatter']);
    expect(view.searchHits('verschönern')).toEqual(['json-formatter']);
  });

  it('formats the example at once and says it is valid', async () => {
    await openTool(manifest);
    expect(result()).toContain('{\n  "name": "stuffcloud",\n  "tags": [');
    await waitFor(() => {
      expect(statuses()).toBe('Valid JSON. 9 values, nested 3 deep.');
    });
  });

  it('formats with four spaces, a tab, or on one line, and sorts keys on request', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, '{"b":[1,2],"a":{"d":1,"c":2}}');
    const layout = screen.getByRole('combobox', { name: 'Layout' });
    await user.selectOptions(layout, '4');
    expect(result()).toBe(
      '{\n    "b": [\n        1,\n        2\n    ],\n    "a": {\n        "d": 1,\n        "c": 2\n    }\n}',
    );
    await user.selectOptions(layout, 'tab');
    expect(result()).toContain('\n\t"b": [\n\t\t1,');
    await user.selectOptions(layout, 'min');
    expect(result()).toBe('{"b":[1,2],"a":{"d":1,"c":2}}');
    await user.click(screen.getByRole('checkbox', { name: 'Sort the keys' }));
    expect(result()).toBe('{"a":{"c":2,"d":1},"b":[1,2]}');
  });

  it('says where the JSON is wrong, and goes there on request', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, '{\n  "a": 1\n  "b": 2\n}');
    await waitFor(() => {
      expect(statuses()).toBe(
        'Unexpected “"”. Expected a comma or the closing brace. (line 3, column 3)',
      );
    });
    expect(result()).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'Go to the error' }));
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(input().value.indexOf('"b"'));
  });

  it('reads comments and JSON5, tells so, and refuses them in strict mode', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, "// note\n{a: 'x', b: [1,],}");
    expect(result()).toBe('{\n  "a": "x",\n  "b": [\n    1\n  ]\n}');
    await waitFor(() => {
      expect(statuses()).toBe(
        'Valid, but not strict JSON: it uses comments, trailing commas, single-quoted strings, and keys without quotes. The result is strict JSON.',
      );
    });
    await user.click(
      screen.getByRole('checkbox', { name: 'Strict JSON only (no comments, no JSON5)' }),
    );
    await waitFor(() => {
      expect(statuses()).toBe('Strict JSON does not allow comments. (line 1, column 1)');
    });
    expect(result()).toBeUndefined();
  });

  it('warns about duplicate keys and numbers that are too long, and keeps the numbers', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, '{"a":1,"a":2,"n":12345678901234567890}');
    expect(result()).toContain('"n": 12345678901234567890');
    const notes = [...document.querySelectorAll('.notes li')].map((item) => item.textContent);
    expect(notes).toEqual([
      '1 key appears twice in the same object. Most programs keep only the last one.',
      '1 number has more digits than a JavaScript number can hold. The result keeps it exactly as written.',
    ]);
  });

  it('shows the path at the cursor', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, '{"a":[10,{"b c":true}]}');
    expect(screen.getByText('Path at the cursor: $')).toBeTruthy();
    input().setSelectionRange(input().value.indexOf('true'), input().value.indexOf('true'));
    await fireEvent.click(input());
    expect(screen.getByText('Path at the cursor: $.a[1]["b c"]')).toBeTruthy();
    input().setSelectionRange(input().value.indexOf('10'), input().value.indexOf('10'));
    await fireEvent.keyUp(input());
    expect(screen.getByText('Path at the cursor: $.a[0]')).toBeTruthy();
    await fireEvent.select(input());
  });

  it('finds a value by its path, and says when there is none or the path is wrong', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, '{"a":[10,{"b c":true}]}');
    const path = screen.getByRole('textbox', { name: 'Find a value by its path' });
    await user.click(path);
    await user.paste('$.a[1]');
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Value at this path' }).value,
    ).toBe('{\n  "b c": true\n}');
    await user.clear(path);
    await user.click(path);
    await user.paste('$.x');
    expect(screen.getByText('There is no value at this path.')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Value at this path' })).toBeNull();
    await user.clear(path);
    await user.click(path);
    await user.paste('$.a[');
    expect(screen.getByText('This is not a valid path (problem at character 5).')).toBeTruthy();
    expect(path.getAttribute('aria-invalid')).toBe('true');
    await user.clear(path);
    expect(screen.queryByText('There is no value at this path.')).toBeNull();
  });

  it('uses the result as the input', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, '{"a":1}');
    await user.click(screen.getByRole('button', { name: 'Use the result as the input' }));
    expect(input().value).toBe('{\n  "a": 1\n}');
  });

  it('copies the result and offers it as a download', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, '{"a":1}');
    await user.click(screen.getByRole('button', { name: 'Copy result' }));
    expect(await navigator.clipboard.readText()).toBe('{\n  "a": 1\n}');
    const create = vi.fn(() => 'blob:json');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: 'Download result' }));
    expect(create).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(revoke).toHaveBeenCalledWith('blob:json');
    });
  });

  it('refuses a text that is too long, without trying to read it', async () => {
    await openTool(manifest);
    await fireEvent.input(input(), { target: { value: ' '.repeat(2_000_001) } });
    await waitFor(() => {
      expect(statuses()).toBe('The text is longer than 2,000,000 characters.');
    });
    expect(result()).toBeUndefined();
  });

  it('has nothing to show for an empty text but the error', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await user.clear(input());
    await waitFor(() => {
      expect(statuses()).toBe('There is no JSON in the text. (line 1, column 1)');
    });
  });

  it('speaks German', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    i18n.setLocale('de');
    await paste(user, '[1,]');
    await user.click(
      await screen.findByRole('checkbox', {
        name: 'Nur striktes JSON (keine Kommentare, kein JSON5)',
      }),
    );
    await waitFor(() => {
      expect(statuses()).toBe(
        'In striktem JSON nicht erlaubt: Kommas am Ende. (Zeile 1, Spalte 3)',
      );
    });
  });
});
