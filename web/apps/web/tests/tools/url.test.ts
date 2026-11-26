import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/url/manifest.ts';
import { toaster } from '../../src/ui/toast.svelte.ts';
import { openTool } from '../tool-helpers.ts';
import { fieldErrorText } from '../helpers.ts';

type User = ReturnType<typeof userEvent.setup>;

afterEach(() => {
  toaster.clear();
  vi.restoreAllMocks();
  i18n.setLocale('en');
});

function text(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Text' });
}

function address(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'URL' });
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

function table(name: string): string[][] {
  return within(screen.getByRole('table', { name }))
    .getAllByRole('row')
    .slice(1)
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent.trim()));
}

async function paste(user: User, field: HTMLElement, value: string): Promise<void> {
  await user.clear(field);
  await user.click(field);
  if (value !== '') {
    await user.paste(value);
  }
}

describe('url', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/url with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/url');
    expect(view.headings).toEqual(['URL encoder and parser']);
    expect(view.searchHits('percent')).toEqual(['url']);
    expect(view.searchHits('kodieren')).toEqual(['url']);
  });
});

describe('encoding and decoding', () => {
  it('encodes a component and announces it', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    expect(result()).toBeUndefined();
    await paste(user, text(), 'a b&c=ä');
    await user.click(screen.getByRole('button', { name: 'Encode' }));
    expect(result()).toBe('a%20b%26c%3D%C3%A4');
    expect(statuses()).toContain('Encoded. The result is below.');
  });

  it('decodes, and a mode changes what the result looks like', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, text(), 'a+b%2Fc%20d');
    await user.click(screen.getByRole('button', { name: 'Decode' }));
    expect(result()).toBe('a+b/c d');
    expect(statuses()).toContain('Decoded. The result is below.');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind of encoding' }), 'form');
    expect(screen.getByText(/Like a component, but a space becomes \+/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Decode' }));
    expect(result()).toBe('a b/c d');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind of encoding' }), 'uri');
    expect(screen.getByText(/Keeps the characters that give a URL its structure/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Decode' }));
    expect(result()).toBe('a+b%2Fc d');
  });

  it('says where a percent sequence is broken, in the alert region, and shows no result', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, text(), 'ok%2');
    await user.click(screen.getByRole('button', { name: 'Decode' }));
    expect(document.querySelector('main .tool-status.alert')?.textContent).toContain(
      'the percent sequence at character 3',
    );
    expect(result()).toBeUndefined();
    await paste(user, text(), 'fine');
    await user.click(screen.getByRole('button', { name: 'Decode' }));
    expect(document.querySelector('main .tool-status.alert')?.textContent).toBe('');
    expect(result()).toBe('fine');
  });

  it('says a lone surrogate cannot be encoded', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, text(), 'x\ud800');
    await user.click(screen.getByRole('button', { name: 'Encode' }));
    expect(document.querySelector('main .tool-status.alert')?.textContent).toContain(
      'unpaired surrogate',
    );
    expect(result()).toBeUndefined();
  });

  it('refuses a text that is too long, in the field', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await user.click(text());
    await user.paste('a'.repeat(100_001));
    expect(fieldErrorText()).toBe('This text is too long (at most 100,000 characters).');
    await user.click(screen.getByRole('button', { name: 'Encode' }));
    expect(result()).toBeUndefined();
    expect(statuses()).toBe('');
  });

  it('copies the result and confirms it', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await openTool(manifest);
    await paste(user, text(), 'a b');
    await user.click(screen.getByRole('button', { name: 'Encode' }));
    await user.click(screen.getByRole('button', { name: 'Copy result' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('a%20b');
    });
    expect(screen.getByRole('region', { name: 'Notifications' }).textContent).toContain(
      'Copied the result',
    );
  });
});

describe('parsing', () => {
  it('starts with an example, listing the parts and the query parameters', async () => {
    await openTool(manifest);
    expect(table('The parts of the URL')).toEqual([
      ['Normalised URL', 'https://user@example.com:8443/a%20b/c?x=1&y=two+words&x=3#top'],
      ['Scheme', 'https:'],
      ['User name', 'user'],
      ['Host', 'example.com'],
      ['Port', '8443'],
      ['Path', '/a%20b/c'],
      ['Query', '?x=1&y=two+words&x=3'],
      ['Fragment', '#top'],
      ['Origin', 'https://example.com:8443'],
    ]);
    expect(table('The query parameters in order, decoded')).toEqual([
      ['x', '1'],
      ['y', 'two words'],
      ['x', '3'],
    ]);
  });

  it('follows the address, shows empty values, and announces when the field is left', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, address(), 'http://example.org/?empty=&one=1');
    expect(table('The query parameters in order, decoded')).toEqual([
      ['empty', '(empty)'],
      ['one', '1'],
    ]);
    await user.tab();
    expect(statuses()).toBe('Parsed: host example.org, 2 query parameters.');
    await paste(user, address(), 'http://example.org/?one=1');
    await user.tab();
    expect(statuses()).toBe('Parsed: host example.org, 1 query parameter.');
  });

  it('shows no query table when there is no query', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, address(), 'https://example.com');
    expect(
      screen.queryByRole('table', { name: 'The query parameters in order, decoded' }),
    ).toBeNull();
    expect(screen.getByRole('table', { name: 'The parts of the URL' })).toBeTruthy();
  });

  it('marks text that is no URL and announces it', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, address(), 'example.com/path');
    expect(address().getAttribute('aria-invalid')).toBe('true');
    expect(fieldErrorText()).toBe(
      'This is not a complete URL. It needs a scheme such as https:// at the start.',
    );
    expect(screen.queryByRole('table', { name: 'The parts of the URL' })).toBeNull();
    await user.tab();
    expect(statuses()).toContain('This is not a complete URL.');
  });

  it('says nothing about an empty field and refuses a too long one', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await paste(user, address(), '');
    expect(fieldErrorText()).toBeNull();
    expect(screen.queryByRole('table', { name: 'The parts of the URL' })).toBeNull();
    await user.click(address());
    await user.paste(`https://example.com/${'a'.repeat(100_001)}`);
    expect(fieldErrorText()).toBe('This text is too long (at most 100,000 characters).');
  });

  it('shows German texts', async () => {
    await openTool(manifest);
    i18n.setLocale('de');
    expect(await screen.findByRole('button', { name: 'Dekodieren' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Die Bestandteile der URL' })).toBeTruthy();
  });
});
