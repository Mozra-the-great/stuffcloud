import { screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/uuid/manifest.ts';
import { v7Milliseconds } from '../../src/tools/uuid/uuid.ts';
import { toaster } from '../../src/ui/toast.svelte.ts';
import { openTool } from '../tool-helpers.ts';

const downloads = vi.hoisted(() => ({
  saved: [] as { name: string; text: string }[],
}));

vi.mock('../../src/app/download.ts', () => ({
  saveText: (name: string, text: string) => {
    downloads.saved.push({ name, text });
  },
  saveBlob: () => undefined,
}));

type User = ReturnType<typeof userEvent.setup>;

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  downloads.saved = [];
});

afterEach(() => {
  toaster.clear();
  vi.restoreAllMocks();
  i18n.setLocale('en');
});

function list(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'UUIDs, one per line' });
}

function uuids(): string[] {
  return list().value === '' ? [] : list().value.split('\n');
}

function count(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('spinbutton', { name: 'How many' });
}

function statusText(): string {
  return [...document.querySelectorAll('main .tool-status')]
    .map((region) => region.textContent.trim())
    .join('');
}

async function setCount(user: User, value: string): Promise<void> {
  await user.clear(count());
  if (value !== '') {
    await user.type(count(), value);
  }
}

async function shown(): Promise<void> {
  await waitFor(() => {
    expect(uuids().length).toBeGreaterThan(0);
  });
}

describe('uuid', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/uuid with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/uuid');
    expect(view.headings).toEqual(['UUID generator']);
    expect(view.searchHits('uuid generator')).toEqual(['uuid']);
    expect(view.searchHits('guid')).toEqual(['uuid']);
  });

  it('shows five version 4 UUIDs at once, in a read-only field, without announcing them', async () => {
    await openTool(manifest);
    await shown();
    expect(list().readOnly).toBe(true);
    expect(uuids()).toHaveLength(5);
    for (const uuid of uuids()) {
      expect(uuid).toMatch(V4);
    }
    expect(statusText()).toBe('');
  });

  it('makes new UUIDs on request and announces how many', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await shown();
    const first = uuids();
    await user.click(screen.getByRole('button', { name: 'Generate new UUIDs' }));
    expect(uuids()).toHaveLength(5);
    expect(uuids()).not.toEqual(first);
    expect(statusText()).toBe('Generated 5 version 4 UUIDs.');
    await setCount(user, '1');
    await user.click(screen.getByRole('button', { name: 'Generate new UUIDs' }));
    expect(statusText()).toBe('Generated 1 version 4 UUID.');
  });

  it('makes version 7 UUIDs that stay in order across several clicks', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await shown();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Version' }), 'v7');
    await setCount(user, '200');
    const all: string[] = [...uuids()];
    expect(all).toHaveLength(200);
    for (let click = 0; click < 3; click += 1) {
      await user.click(screen.getByRole('button', { name: 'Generate new UUIDs' }));
      all.push(...uuids());
    }
    expect(all).toHaveLength(800);
    for (const uuid of all) {
      expect(uuid).toMatch(V7);
    }
    expect([...all].sort()).toEqual(all);
    expect(new Set(all).size).toBe(800);
    expect(v7Milliseconds(all[0] ?? '')).toBeLessThanOrEqual(Date.now());
    expect(statusText()).toBe('Generated 200 version 7 UUIDs, in order.');
    expect(screen.getByText(/The first 48 bits are the time/)).toBeTruthy();
  });

  it('formats the same UUIDs as upper case and without hyphens, and back', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await shown();
    const plain = uuids();
    await user.click(screen.getByRole('checkbox', { name: 'Uppercase letters' }));
    expect(uuids()).toEqual(plain.map((uuid) => uuid.toUpperCase()));
    await user.click(screen.getByRole('checkbox', { name: 'Hyphens' }));
    expect(uuids()).toEqual(plain.map((uuid) => uuid.toUpperCase().replaceAll('-', '')));
    await user.click(screen.getByRole('checkbox', { name: 'Uppercase letters' }));
    await user.click(screen.getByRole('checkbox', { name: 'Hyphens' }));
    expect(uuids()).toEqual(plain);
  });

  it('refuses a count outside 1 to 1000 and says so', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await shown();
    for (const bad of ['0', '1001', '-1', '']) {
      await setCount(user, bad);
      expect(uuids()).toEqual([]);
      expect(document.querySelector('.sc-fld__error')?.textContent).toBe(
        'Enter a whole number from 1 to 1,000.',
      );
      expect(count().getAttribute('aria-invalid')).toBe('true');
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Generate new UUIDs' }).disabled,
      ).toBe(true);
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Download as .txt' }).disabled,
      ).toBe(true);
    }
    await setCount(user, '1000');
    expect(uuids()).toHaveLength(1000);
    expect(document.querySelector('.sc-fld__error')).toBeNull();
  });

  it('copies all UUIDs and downloads them one per line', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await openTool(manifest);
    await shown();
    const text = list().value;
    await user.click(screen.getByRole('button', { name: 'Copy all UUIDs' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(text);
    });
    await user.click(screen.getByRole('button', { name: 'Download as .txt' }));
    expect(downloads.saved).toEqual([{ name: 'uuid-v4.txt', text: `${text}\n` }]);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Version' }), 'v7');
    await user.click(screen.getByRole('button', { name: 'Download as .txt' }));
    expect(downloads.saved[1]?.name).toBe('uuid-v7.txt');
  });

  it('uses only the secure random number generator, never Math.random', async () => {
    const random = vi.spyOn(Math, 'random');
    const secure = vi.spyOn(crypto, 'getRandomValues');
    const user = userEvent.setup();
    await openTool(manifest);
    await shown();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Version' }), 'v7');
    await user.click(screen.getByRole('button', { name: 'Generate new UUIDs' }));
    expect(secure).toHaveBeenCalled();
    const uuidCalls = random.mock.calls.length;
    expect(uuidCalls).toBe(0);
  });

  it('speaks German', async () => {
    await openTool(manifest);
    i18n.setLocale('de');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('UUID-Generator');
    });
    expect(screen.getByRole('button', { name: 'Neue UUIDs erzeugen' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Version' })).toBeTruthy();
  });
});
