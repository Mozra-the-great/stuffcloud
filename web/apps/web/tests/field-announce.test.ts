import { screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { toast } from '@mozra-the-great/kern';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../src/i18n/index.ts';
import macManifest from '../src/tools/mac/manifest.ts';
import userAgentManifest from '../src/tools/user-agent/manifest.ts';
import { MAX_USER_AGENT_LENGTH } from '../src/tools/user-agent/user-agent.ts';
import uuidManifest from '../src/tools/uuid/manifest.ts';
import { FIELD_ERROR } from './helpers.ts';
import { openTool } from './tool-helpers.ts';

/*
 * A field error must reach a screen reader exactly once (docs/ACCESSIBILITY.md, "Live regions").
 * kern's fields announce their error as `role="alert"` unless `announce={false}`; a tool whose own
 * status region says the same message when the visitor leaves the field turns that off, a tool that
 * says nothing keeps kern's alert.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  toast.clear();
  i18n.setLocale('en');
});

/** The live regions (`status`, `alert`, `aria-live`) on the page whose text contains `text`. */
function liveRegionsSaying(text: string): readonly Element[] {
  return [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live]')].filter(
    (region) => region.textContent.includes(text),
  );
}

function fieldError(): Element {
  const error = document.querySelector(FIELD_ERROR);
  if (error === null) {
    throw new Error('no field error on the page');
  }
  return error;
}

describe('a field error is announced exactly once', () => {
  it('by the tool’s own status region when the tool says it (announce={false})', async () => {
    const user = userEvent.setup();
    await openTool(userAgentManifest);
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'User-agent string' });
    await user.click(input);
    await user.paste('x'.repeat(MAX_USER_AGENT_LENGTH + 1));

    // Typing says nothing: the error is on screen and linked, but no live region repeats it.
    const error = fieldError();
    const text = error.textContent.trim();
    expect(text).toContain('too long');
    expect(error.getAttribute('role')).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')?.split(' ')[0]).toBe(error.id);
    expect(liveRegionsSaying(text)).toHaveLength(0);

    // Leaving the field makes the tool say it, in its status region and nowhere else.
    await user.tab();
    const regions = liveRegionsSaying(text);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.getAttribute('role')).toBe('status');
    expect(regions[0]).not.toBe(error);
    expect(regions.some((region) => region.getAttribute('role') === 'alert')).toBe(false);
  });

  it('also for the multi-line field (Textarea, announce={false})', async () => {
    // The tool makes its worker pool when it opens; jsdom has no Worker.
    vi.stubGlobal(
      'Worker',
      class FakeWorker {
        readonly terminate = vi.fn();
      },
    );
    const user = userEvent.setup();
    await openTool(macManifest);
    const area = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'MAC addresses' });
    await user.clear(area);
    await user.click(area);
    await user.paste('00:1a:2b:3c:4d');

    const error = fieldError();
    const text = error.textContent.trim();
    expect(text).toBe('A MAC address has 12 hexadecimal digits (EUI-48) or 16 (EUI-64).');
    expect(error.getAttribute('role')).toBeNull();
    expect(area.getAttribute('aria-invalid')).toBe('true');
    expect(area.getAttribute('aria-describedby')?.split(' ')[0]).toBe(error.id);
    expect(liveRegionsSaying(text)).toHaveLength(0);

    await user.tab();
    const regions = liveRegionsSaying(text);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.getAttribute('role')).toBe('status');
    expect(regions[0]).not.toBe(error);
  });

  it('by kern’s alert when the tool has no message of its own for it', async () => {
    const user = userEvent.setup();
    await openTool(uuidManifest);
    const count = screen.getByRole<HTMLInputElement>('spinbutton', { name: 'How many' });
    await user.clear(count);
    await user.type(count, '0');

    const error = fieldError();
    const text = error.textContent.trim();
    expect(text).toBe('Enter a whole number from 1 to 1,000.');
    expect(error.getAttribute('role')).toBe('alert');
    expect(count.getAttribute('aria-describedby')?.split(' ')[0]).toBe(error.id);
    // The alert is the only live region that says it; the tool's status region stays empty.
    expect(liveRegionsSaying(text)).toEqual([error]);
    await user.tab();
    expect(liveRegionsSaying(text)).toEqual([error]);
    expect(document.querySelector('main .tool-status')?.textContent.trim()).toBe('');
  });
});
