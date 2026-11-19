import { screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/password/manifest.ts';
import { toaster } from '../../src/ui/toast.svelte.ts';
import { openTool } from '../tool-helpers.ts';

type User = ReturnType<typeof userEvent.setup>;

afterEach(() => {
  toaster.clear();
  vi.restoreAllMocks();
  i18n.setLocale('en');
});

function password(): string {
  return document.querySelector('.password')?.textContent ?? '';
}

function length(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Length' });
}

function statusText(): string {
  return [...document.querySelectorAll('main .tool-status')]
    .map((region) => region.textContent.trim())
    .join('');
}

async function setLength(user: User, value: string): Promise<void> {
  await user.clear(length());
  if (value !== '') {
    await user.type(length(), value);
  }
}

describe('password', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/password with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/password');
    expect(view.headings).toEqual(['Password generator']);
    expect(view.searchHits('password')).toEqual(['password']);
    expect(view.searchHits('passwort')).toEqual(['password']);
  });
});

describe('generating', () => {
  it('shows a password of 20 characters with its entropy at once', async () => {
    await openTool(manifest);
    expect(password()).toHaveLength(20);
    expect(document.querySelector('.meter')?.textContent).toMatch(
      /^Entropy: \d+(\.\d)? bits · very strong · 90 possible characters$/,
    );
    expect(statusText()).toBe('');
  });

  it('makes another password and announces it without saying the password', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    const first = password();
    await user.click(screen.getByRole('button', { name: 'Generate a new password' }));
    expect(password()).not.toBe(first);
    expect(statusText()).toMatch(/^New password ready\. Entropy \d+(\.\d)? bits, very strong\.$/);
    expect(statusText()).not.toContain(password());
  });

  it('follows the length as it is typed, and reports a length that cannot be used', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await setLength(user, '8');
    expect(password()).toHaveLength(8);
    await setLength(user, '128');
    expect(password()).toHaveLength(128);
    await setLength(user, '129');
    expect(password()).toBe('');
    expect(document.querySelector('.sc-fld__error')?.textContent).toBe(
      'Enter a whole number from 4 to 128.',
    );
    expect(length().getAttribute('aria-invalid')).toBe('true');
    const button = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Generate a new password',
    });
    expect(button.disabled).toBe(true);
    await setLength(user, '3');
    expect(password()).toBe('');
    await setLength(user, '');
    expect(password()).toBe('');
    await setLength(user, '12');
    expect(password()).toHaveLength(12);
    expect(document.querySelector('.sc-fld__error')).toBeNull();
  });

  it('uses only the chosen kinds and says when none is chosen', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    for (const name of ['Uppercase letters (A to Z)', 'Digits (0 to 9)', 'Symbols (!#$%&…)']) {
      await user.click(screen.getByRole('checkbox', { name }));
    }
    expect(password()).toMatch(/^[a-z]{20}$/);
    expect(document.querySelector('.meter')?.textContent).toContain('26 possible characters');
    await user.click(screen.getByRole('checkbox', { name: 'Lowercase letters (a to z)' }));
    expect(password()).toBe('');
    expect(screen.getByText('Choose at least one kind of character.')).toBeTruthy();
  });

  it('allows the shortest length when all kinds are wanted', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await setLength(user, '4');
    expect(password()).toHaveLength(4);
    expect(screen.getByText('From 4 to 128 characters.')).toBeTruthy();
  });

  it('leaves out look-alike characters on request', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await setLength(user, '100');
    await user.click(screen.getByRole('checkbox', { name: /Leave out look-alike/ }));
    expect(password()).toHaveLength(100);
    expect(password()).not.toMatch(/[Il1|O0o]/);
    expect(document.querySelector('.meter')?.textContent).toContain('possible characters');
  });

  it('copies the password and confirms it without repeating it', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await openTool(manifest);
    const shown = password();
    await user.click(screen.getByRole('button', { name: 'Copy password' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(shown);
    });
    expect(screen.getByRole('region', { name: 'Notifications' }).textContent).toContain(
      'Copied the password',
    );
  });

  it('shows German texts', async () => {
    await openTool(manifest);
    i18n.setLocale('de');
    expect(await screen.findByRole('button', { name: 'Neues Passwort erzeugen' })).toBeTruthy();
    expect(document.querySelector('.meter')?.textContent).toMatch(/^Entropie: .* sehr stark/);
  });
});
