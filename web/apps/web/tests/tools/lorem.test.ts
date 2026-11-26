import { screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/lorem/manifest.ts';
import { toaster } from '../../src/ui/toast.svelte.ts';
import { openTool } from '../tool-helpers.ts';
import { fieldErrorText } from '../helpers.ts';

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

beforeEach(() => {
  downloads.saved = [];
});

afterEach(() => {
  toaster.clear();
  vi.restoreAllMocks();
  i18n.setLocale('en');
});

function output(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Placeholder text' });
}

function amount(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Amount' });
}

function statusText(): string {
  return [...document.querySelectorAll('main .tool-status')]
    .map((region) => region.textContent.trim())
    .join('');
}

async function setAmount(user: User, value: string): Promise<void> {
  await user.clear(amount());
  if (value !== '') {
    await user.type(amount(), value);
  }
}

describe('lorem', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/lorem with one heading and is found in both languages', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/lorem');
    expect(view.headings).toEqual(['Lorem ipsum generator']);
    expect(view.searchHits('lorem ipsum')).toEqual(['lorem']);
    expect(view.searchHits('blindtext')).toEqual(['lorem']);
  });

  it('shows three paragraphs that begin with the classic opening, in a read-only field', async () => {
    await openTool(manifest);
    expect(output().readOnly).toBe(true);
    expect(output().value.split('\n\n')).toHaveLength(3);
    expect(
      output().value.startsWith('Lorem ipsum dolor sit amet, consectetur adipiscing elit.'),
    ).toBe(true);
    expect(statusText()).toBe('');
  });

  it('changes the amount to what the unit usually takes, and follows the amount as it is typed', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Unit' }), 'words');
    expect(amount().value).toBe('50');
    expect(output().value.split(' ')).toHaveLength(50);
    await setAmount(user, '7');
    expect(output().value).toBe('lorem ipsum dolor sit amet consectetur adipiscing');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Unit' }), 'sentences');
    expect(amount().value).toBe('5');
    expect(output().value.split('. ').length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText('From 1 to 1,000.')).toBeTruthy();
  });

  it('drops the classic opening when asked to', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await user.click(screen.getByRole('checkbox', { name: /Start with/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Unit' }), 'words');
    await setAmount(user, '40');
    expect(
      output().value.startsWith('lorem ipsum dolor sit amet consectetur adipiscing elit'),
    ).toBe(false);
  });

  it('reports an amount that cannot be used, and recovers', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Unit' }), 'words');
    for (const bad of ['0', '5001', '-3', '']) {
      await setAmount(user, bad);
      expect(output().value).toBe('');
      expect(fieldErrorText()).toBe('Enter a whole number from 1 to 5,000.');
      expect(amount().getAttribute('aria-invalid')).toBe('true');
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Generate new text' }).disabled,
      ).toBe(true);
    }
    await setAmount(user, '12');
    expect(output().value.split(' ')).toHaveLength(12);
    expect(fieldErrorText()).toBeNull();
  });

  it('makes new text on request and announces it without reading it out', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Unit' }), 'words');
    await setAmount(user, '30');
    await user.click(screen.getByRole('checkbox', { name: /Start with/ }));
    const first = output().value;
    await user.click(screen.getByRole('button', { name: 'Generate new text' }));
    expect(output().value).not.toBe(first);
    expect(statusText()).toBe('New text ready.');
  });

  it('copies the text and downloads it as a file', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await openTool(manifest);
    const shown = output().value;
    await user.click(screen.getByRole('button', { name: 'Copy text' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(shown);
    });
    await user.click(screen.getByRole('button', { name: 'Download as .txt' }));
    expect(downloads.saved).toEqual([{ name: 'lorem-ipsum.txt', text: shown }]);
  });

  it('cannot download when there is no text', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await setAmount(user, '0');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Download as .txt' }).disabled,
    ).toBe(true);
  });

  it('speaks German', async () => {
    await openTool(manifest);
    i18n.setLocale('de');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Lorem-ipsum-Generator');
    });
    expect(screen.getByRole('combobox', { name: 'Einheit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Neuen Text erzeugen' })).toBeTruthy();
  });
});
