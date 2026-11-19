import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/sql-formatter/manifest.ts';
import { openTool } from '../tool-helpers.ts';

type User = ReturnType<typeof userEvent.setup>;

afterEach(() => {
  vi.restoreAllMocks();
  i18n.setLocale('en');
});

function input(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'SQL' });
}

function result(): string | undefined {
  return screen.queryByRole<HTMLTextAreaElement>('textbox', { name: 'Formatted SQL' })?.value;
}

function statuses(): string {
  return [...document.querySelectorAll('main .tool-status')]
    .map((region) => region.textContent.trim())
    .filter((line) => line !== '')
    .join('|');
}

async function write(user: User, value: string): Promise<void> {
  await user.clear(input());
  if (value !== '') {
    await user.click(input());
    await user.paste(value);
  }
}

describe('sql-formatter', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/sql-formatter with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/sql-formatter');
    expect(view.headings).toEqual(['SQL formatter']);
    expect(view.searchHits('postgres')).toEqual(['sql-formatter']);
    expect(view.searchHits('formatieren')).toEqual(['sql-formatter']);
  });

  it('formats the example at once and counts the lines', async () => {
    await openTool(manifest);
    expect(
      result()?.startsWith(
        'SELECT\n  u.id,\n  u.name,\n  count(o.id) AS orders\nFROM\n  users u\nLEFT JOIN orders o ON o.user_id = u.id',
      ),
    ).toBe(true);
    await waitFor(() => {
      expect(statuses()).toMatch(/^Formatted: \d+ lines\.$/);
    });
  });

  it('formats what is typed, with the keywords in the case chosen', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await write(user, 'Select a From t');
    expect(result()).toBe('SELECT\n  a\nFROM\n  t');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Keywords' }), 'lower');
    expect(result()).toBe('select\n  a\nfrom\n  t');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Keywords' }), 'preserve');
    expect(result()).toBe('Select\n  a\nFrom\n  t');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Keywords' }), 'upper');
    expect(result()).toBe('SELECT\n  a\nFROM\n  t');
  });

  it('lays out with four spaces, a tab, or on one line', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await write(user, 'select a from t');
    const layout = screen.getByRole('combobox', { name: 'Layout' });
    await user.selectOptions(layout, '4');
    expect(result()).toBe('SELECT\n    a\nFROM\n    t');
    await user.selectOptions(layout, 'tab');
    expect(result()).toBe('SELECT\n\ta\nFROM\n\tt');
    await user.selectOptions(layout, 'min');
    expect(result()).toBe('SELECT a FROM t');
  });

  it('reads the quotes of the dialect chosen', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await write(user, 'select `a b` from t where c = "x"');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Dialect' }), 'mysql');
    expect(result()).toBe('SELECT\n  `a b`\nFROM\n  t\nWHERE\n  c = "x"');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Dialect' }), 'sqlserver');
    expect(result()).not.toBeUndefined();
  });

  it('says there is nothing to format yet for an empty text', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await write(user, '');
    await waitFor(() => {
      expect(statuses()).toBe('Nothing to format yet.');
    });
    expect(result()).toBeUndefined();
  });

  it('uses the result as the input, copies it and offers it as a download', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await write(user, 'select a from t');
    await user.click(screen.getByRole('button', { name: 'Copy result' }));
    expect(await navigator.clipboard.readText()).toBe('SELECT\n  a\nFROM\n  t');
    const create = vi.fn(() => 'blob:sql');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: 'Download result' }));
    expect(click).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Use the result as the input' }));
    expect(input().value).toBe('SELECT\n  a\nFROM\n  t');
  });

  it('refuses a text that is too long', async () => {
    await openTool(manifest);
    await fireEvent.input(input(), { target: { value: ' select'.repeat(200_000) } });
    await waitFor(() => {
      expect(statuses()).toBe('The text is longer than 1,000,000 characters.');
    });
    expect(result()).toBeUndefined();
  });

  it('says what it does not do', async () => {
    await openTool(manifest);
    expect(
      screen.getByText(/does not check that the SQL is valid, and it never runs it/),
    ).toBeTruthy();
  });

  it('speaks German', async () => {
    await openTool(manifest);
    i18n.setLocale('de');
    expect(await screen.findByRole('combobox', { name: 'Schlüsselwörter' })).toBeTruthy();
    await waitFor(() => {
      expect(statuses()).toMatch(/^Formatiert: \d+ Zeilen\.$/);
    });
  });
});
