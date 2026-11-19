import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import jsQR from 'jsqr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import { buildQr, decodeScene, scanTest, type ScanTest } from '../../src/tools/qr/check.ts';
import type * as QrCheck from '../../src/tools/qr/check.ts';
import manifest from '../../src/tools/qr/manifest.ts';
import { toRgba } from '../../src/tools/qr/render.ts';
import { toaster } from '../../src/ui/toast.svelte.ts';
import { openTool } from '../tool-helpers.ts';
import { defined } from './defined.ts';
import { readPng } from './qr-helpers.ts';

const state = vi.hoisted(() => ({
  /** `real` runs the scan test; `styled` fails it for the stuffcloud style; `all` fails it always. */
  scan: 'real',
  blobs: [] as { name: string; blob: Blob }[],
  texts: [] as { name: string; text: string; type: string | undefined }[],
  /** The pictures the page made object URLs for, and the URLs it gave back. */
  made: new Map<string, Blob>(),
  revoked: [] as string[],
}));

vi.mock('../../src/app/download.ts', () => ({
  saveBlob: (name: string, blob: Blob) => {
    state.blobs.push({ name, blob });
  },
  saveText: (name: string, text: string, type?: string) => {
    state.texts.push({ name, text, type });
  },
}));

vi.mock('../../src/tools/qr/check.ts', async (importOriginal) => {
  const original = await importOriginal<typeof QrCheck>();
  const scan: ScanTest = (scene, text) => {
    if (state.scan === 'all') {
      return false;
    }
    if (state.scan === 'styled' && scene.layers.length > 2) {
      return false;
    }
    return original.scanTest(scene, text);
  };
  return {
    ...original,
    buildQr: (text: string, requested: Parameters<typeof original.buildQr>[1]) =>
      original.buildQr(text, requested, scan),
  };
});

type User = ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  state.scan = 'real';
  state.blobs = [];
  state.texts = [];
  state.made = new Map();
  state.revoked = [];
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob): string => {
      const url = `blob:picture/${String(state.made.size)}`;
      state.made.set(url, blob);
      return url;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: (url: string): void => {
      state.revoked.push(url);
    },
  });
});

afterEach(() => {
  toaster.clear();
  vi.restoreAllMocks();
  i18n.setLocale('en');
});

function statusText(): string {
  return [...document.querySelectorAll('main .tool-status:not(.alert)')]
    .map((region) => region.textContent.trim())
    .join('');
}

function alertText(): string {
  return document.querySelector('main .tool-status.alert')?.textContent.trim() ?? '';
}

function picture(): HTMLImageElement | null {
  return screen.queryByRole<HTMLImageElement>('img', { name: /^QR code/ });
}

/** The SVG document the picture on the page shows. */
async function shownSvg(image: HTMLImageElement | null): Promise<string> {
  const blob = defined(state.made.get(defined(image).src));
  expect(blob.type).toBe('image/svg+xml');
  return await blob.text();
}

function content(): string {
  return document.querySelector('#qr-content')?.textContent ?? '';
}

async function typeText(user: User, value: string): Promise<void> {
  const field = screen.getByRole('textbox', { name: 'Text or URL' });
  await user.clear(field);
  // `fireEvent.input` sets a long text at once; typing it would take long, and `[` is a key to `user.type`.
  await fireEvent.input(field, { target: { value } });
}

async function picked(): Promise<HTMLImageElement> {
  return await waitFor(() => {
    const image = picture();
    expect(image).not.toBeNull();
    return defined(image);
  });
}

describe('qr', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/qr with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/qr');
    expect(view.headings).toEqual(['QR code generator']);
    expect(view.searchHits('qr code')).toEqual(['qr']);
    expect(view.searchHits('wlan')).toEqual(['qr']);
  });

  it('asks for content first and shows no code, and has both status regions from the start', async () => {
    await openTool(manifest);
    expect(picture()).toBeNull();
    expect(screen.getByText('Type a text or a link to see the code.')).toBeTruthy();
    expect(document.querySelectorAll('main .tool-status')).toHaveLength(2);
    expect(document.querySelector('main .tool-status.alert')?.getAttribute('role')).toBe('alert');
    expect(screen.queryByRole('button', { name: 'Download PNG' })).toBeNull();
  });
});

describe('a code for a text', () => {
  it('shows the stuffcloud style with a text alternative, the readable content and a passed scan test', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await typeText(user, 'https://example.org/hello?x=1');
    const image = await picked();
    expect(image.alt).toBe('QR code. Its content is written below.');
    expect(image.getAttribute('aria-describedby')).toBe('qr-content');
    expect(content()).toBe('https://example.org/hello?x=1');
    expect(screen.getByRole('group', { name: 'Encoded content' })).toBeTruthy();
    expect(image.src.startsWith('blob:')).toBe(true);
    expect(screen.getByText(/Scan test passed/)).toBeTruthy();
    await waitFor(() => {
      expect(statusText()).toBe('QR code ready. The scan test passed.');
    });
    expect(alertText()).toBe('');
    // The picture on the page is the one that passed: the same document as the code made for the text.
    const built = buildQr('https://example.org/hello?x=1', { style: 'stuffcloud', ecc: 'H' });
    expect(built.ok && built.code.svg).toBe(await shownSvg(image));
  });

  it('fixes the level at H for the stuffcloud style and lets the raw style choose', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await typeText(user, 'level');
    await picked();
    const level = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Error correction' });
    expect(level.disabled).toBe(true);
    expect(level.value).toBe('H');
    expect(screen.getByText(/always uses level H/)).toBeTruthy();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Style' }), 'raw');
    const raw = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Error correction' });
    expect(raw.disabled).toBe(false);
    const before = (await picked()).src;
    await user.selectOptions(raw, 'L');
    await waitFor(() => {
      expect(picture()?.src).not.toBe(before);
    });
    const built = buildQr('level', { style: 'raw', ecc: 'L' });
    expect(built.ok && built.code.svg).toBe(await shownSvg(picture()));
    expect(screen.queryByText(/always uses level H/)).toBeNull();
  });

  it('follows the text as it changes and goes back to the hint when it is emptied', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await typeText(user, 'one');
    const first = (await picked()).src;
    await typeText(user, 'two');
    await waitFor(() => {
      expect(content()).toBe('two');
    });
    expect(picture()?.src).not.toBe(first);
    // The picture that is gone is given back to the browser.
    expect(state.revoked).toContain(first);
    await typeText(user, '');
    await waitFor(() => {
      expect(picture()).toBeNull();
    });
    expect(statusText()).toBe('');
    expect(screen.getByText('Type a text or a link to see the code.')).toBeTruthy();
  });

  it('shows a text with special characters and line breaks exactly as encoded', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    const text = 'Zeile 1\nZeile 2 — grüße 日本語 😀 <b>"&</b>';
    await typeText(user, text);
    await picked();
    expect(content()).toBe(text);
  });

  it('says so when the text is too long for a QR code, and offers nothing', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await typeText(user, 'a'.repeat(3500));
    await waitFor(() => {
      expect(alertText()).toBe('The content is too long for a QR code. Shorten it.');
    });
    expect(picture()).toBeNull();
    expect(statusText()).toBe('');
    await typeText(user, 'short again');
    await picked();
    expect(alertText()).toBe('');
  });
});

describe('falling back', () => {
  it('shows the raw style, says why, and still offers a code when the styled picture does not scan', async () => {
    state.scan = 'styled';
    const user = userEvent.setup();
    await openTool(manifest);
    await typeText(user, 'fallback');
    await picked();
    const message = 'The stuffcloud style did not pass the scan test, so the raw style is shown.';
    expect(screen.getAllByText(message).length).toBeGreaterThanOrEqual(1);
    await waitFor(() => {
      expect(statusText()).toBe(message);
    });
    const built = buildQr('fallback', { style: 'raw', ecc: 'H' });
    expect(built.ok && built.code.svg).toBe(await shownSvg(picture()));
  });

  it('says the text is too long for level H when only the raw style at a lower level fits', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Style' }), 'raw');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Error correction' }), 'L');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Style' }), 'stuffcloud');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Style' }), 'raw');
    await typeText(user, 'b'.repeat(1500));
    await picked();
    expect(screen.queryByText(/too long for the stuffcloud style/)).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Style' }), 'stuffcloud');
    await waitFor(() => {
      expect(statusText()).toBe(
        'The text is too long for the stuffcloud style (level H), so the raw style at your chosen level is shown.',
      );
    });
  });

  it('offers no download when even the raw picture does not scan', async () => {
    state.scan = 'all';
    const user = userEvent.setup();
    await openTool(manifest);
    await typeText(user, 'never scans');
    await waitFor(() => {
      expect(alertText()).toContain('could not be verified by the scan test');
    });
    expect(picture()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download PNG' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download SVG' })).toBeNull();
  });
});

describe('downloads', () => {
  it('downloads an SVG that is the document of the preview', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await typeText(user, 'svg please');
    const image = await picked();
    await user.click(screen.getByRole('button', { name: 'Download SVG' }));
    expect(state.texts).toHaveLength(1);
    expect(state.texts[0]?.name).toBe('qr-code.svg');
    expect(state.texts[0]?.type).toBe('image/svg+xml');
    expect(state.texts[0]?.text).toBe(await shownSvg(image));
    expect(statusText()).toBe('Saved qr-code.svg.');
  });

  it.each(['stuffcloud', 'raw'])(
    'downloads a PNG of the chosen size that a QR reader decodes (%s style)',
    async (style) => {
      const user = userEvent.setup();
      await openTool(manifest);
      const text = 'PNG scan: https://example.org/a?b=c — grüße 😀';
      await typeText(user, text);
      await picked();
      await user.selectOptions(screen.getByRole('combobox', { name: 'Style' }), style);
      await user.selectOptions(screen.getByRole('combobox', { name: 'Size of the PNG' }), '512');
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Download PNG' })).toBeTruthy();
      });
      await waitFor(() => {
        expect(document.querySelector('.scan')).not.toBeNull();
      });
      await user.click(screen.getByRole('button', { name: 'Download PNG' }));
      await waitFor(() => {
        expect(state.blobs).toHaveLength(1);
      });
      const saved = state.blobs[0];
      expect(saved?.name).toBe('qr-code.png');
      expect(saved?.blob.type).toBe('image/png');
      const bytes = new Uint8Array(await defined(saved?.blob).arrayBuffer());
      const raster = readPng(bytes);
      expect(raster.width).toBe(512);
      expect(raster.height).toBe(512);
      const found = jsQR(toRgba(raster), raster.width, raster.height);
      expect(found?.data).toBe(text);
      await waitFor(() => {
        expect(statusText()).toBe('Saved qr-code.png, 512 pixels.');
      });
    },
  );

  it.each(['1024', '2048'])('makes the PNG exactly %s pixels wide', async (size) => {
    const user = userEvent.setup();
    await openTool(manifest);
    await typeText(user, 'size');
    await picked();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Size of the PNG' }), size);
    await user.click(screen.getByRole('button', { name: 'Download PNG' }));
    await waitFor(() => {
      expect(state.blobs).toHaveLength(1);
    });
    const raster = readPng(new Uint8Array(await defined(state.blobs[0]?.blob).arrayBuffer()));
    expect(raster.width).toBe(Number(size));
  });
});

describe('a Wi-Fi code', () => {
  async function chooseWifi(user: User): Promise<void> {
    await user.selectOptions(screen.getByRole('combobox', { name: 'What to encode' }), 'wifi');
  }

  it('asks for the name, then the password, and encodes the login', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await chooseWifi(user);
    expect(screen.getByText('Enter the network name to see the code.')).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'Network name (SSID)' }), 'Home');
    expect(screen.getByText('Enter the password, or choose “No password”.')).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'Password' }), 'secret123');
    await picked();
    expect(content()).toBe('WIFI:T:WPA;S:Home;P:secret123;;');
    await user.click(screen.getByRole('checkbox', { name: 'The network is hidden' }));
    await waitFor(() => {
      expect(content()).toBe('WIFI:T:WPA;S:Home;P:secret123;H:true;;');
    });
  });

  it('leaves the password field out of an open network', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await chooseWifi(user);
    await user.type(screen.getByRole('textbox', { name: 'Network name (SSID)' }), 'Guests');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Security' }), 'nopass');
    expect(screen.queryByRole('textbox', { name: 'Password' })).toBeNull();
    await picked();
    expect(content()).toBe('WIFI:T:nopass;S:Guests;;');
  });

  it('marks a network name that is longer than 32 bytes', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await chooseWifi(user);
    await fireEvent.input(screen.getByRole('textbox', { name: 'Network name (SSID)' }), {
      target: { value: 'x'.repeat(33) },
    });
    await waitFor(() => {
      expect(document.querySelector('.sc-fld__error')?.textContent).toBe(
        'A network name has at most 32 bytes.',
      );
    });
    expect(picture()).toBeNull();
  });

  it('decodes to the same login in a reader', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await chooseWifi(user);
    await user.type(screen.getByRole('textbox', { name: 'Network name (SSID)' }), 'My;Net');
    await user.type(screen.getByRole('textbox', { name: 'Password' }), 'p:a"s,s');
    await picked();
    const built = buildQr(content(), { style: 'stuffcloud', ecc: 'H' });
    expect(built.ok && decodeScene(built.code.scene)).toBe(content());
    expect(content()).toBe(String.raw`WIFI:T:WPA;S:My\;Net;P:p\:a\"s\,s;;`);
  });
});

describe('a contact code', () => {
  it('asks for a name or an organisation, then writes a vCard', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    await user.selectOptions(screen.getByRole('combobox', { name: 'What to encode' }), 'contact');
    expect(
      screen.getByText('Enter a first name, a last name or an organisation to see the code.'),
    ).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'First name' }), 'Ada');
    await user.type(screen.getByRole('textbox', { name: 'Last name' }), 'Lovelace');
    await user.type(screen.getByRole('textbox', { name: 'E-mail' }), 'ada@example.org');
    await picked();
    expect(content()).toBe(
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'N:Lovelace;Ada;;;',
        'FN:Ada Lovelace',
        'EMAIL:ada@example.org',
        'END:VCARD',
      ].join('\r\n'),
    );
    const built = buildQr(content(), { style: 'stuffcloud', ecc: 'H' });
    expect(built.ok && scanTest(built.code.scene, content())).toBe(true);
  });
});

describe('the preview', () => {
  it('gives its object URL back when the page goes away', async () => {
    const user = userEvent.setup();
    const view = await openTool(manifest);
    await typeText(user, 'leaving');
    const shown = (await picked()).src;
    view.router.navigate('/');
    await waitFor(() => {
      expect(state.revoked).toContain(shown);
    });
  });
});

describe('qr in German', () => {
  it('shows German texts', async () => {
    await openTool(manifest);
    i18n.setLocale('de');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('QR-Code-Generator');
    });
    expect(screen.getByText('Gib einen Text oder Link ein, um den Code zu sehen.')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Stil' })).toBeTruthy();
  });
});
