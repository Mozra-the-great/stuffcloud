import { fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/color/manifest.ts';
import { toast } from '@mozra-the-great/kern';
import { openTool } from '../tool-helpers.ts';

type User = ReturnType<typeof userEvent.setup>;

afterEach(() => {
  toast.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  i18n.setLocale('en');
});

describe('color', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/color with exactly one heading: its name', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/color');
    expect(view.headings).toEqual(['Colour picker']);
    expect(view.main.textContent).toContain('Your files stay in this browser');
  });

  it('is found by search, by English and German words', async () => {
    const view = await openTool(manifest);
    expect(view.searchHits('colour picker')).toEqual(['color']);
    expect(view.searchHits('oklch')).toEqual(['color']);
    expect(view.searchHits('contrast')).toEqual(['color']);
  });
});

/** The row of a format in the list of formats: its name, its value and its copy button. */
function formatRow(label: string): { value: string; copy: HTMLElement } {
  const row = screen.getByText(label, { selector: '.format-name' }).closest('li');
  if (row === null) {
    throw new Error(`no row for ${label}`);
  }
  return {
    value: within(row).getByText((_, element) => element?.tagName === 'CODE').textContent,
    copy: within(row).getByRole('button', { name: `Copy ${label}` }),
  };
}

async function type(user: User, label: string | RegExp, text: string): Promise<HTMLInputElement> {
  const field = screen.getByRole<HTMLInputElement>('textbox', { name: label });
  await user.clear(field);
  if (text !== '') {
    await user.type(field, text);
  }
  return field;
}

/** The error line of the tool (the toast region has alerts of its own). */
function problemText(): string {
  return document.querySelector('main [data-tool-status][role="alert"]')?.textContent ?? 'missing';
}

function statusText(): string {
  return screen
    .getAllByRole('status')
    .map((region) => region.textContent.trim())
    .join('|');
}

describe('the colour and its formats', () => {
  let user: User;

  beforeEach(async () => {
    user = userEvent.setup();
    await openTool(manifest);
  });

  it('starts with a colour and shows it in all five formats', () => {
    expect(formatRow('HEX').value).toBe('#3a7bd5');
    expect(formatRow('RGB').value).toBe('rgb(58, 123, 213)');
    expect(formatRow('HSL').value).toMatch(/^hsl\(21\d(\.\d)?, \d+(\.\d)?%, \d+(\.\d)?%\)$/);
    expect(formatRow('OKLCH').value).toMatch(/^oklch\(\d+(\.\d+)?% 0\.\d+ \d+(\.\d+)?\)$/);
    expect(formatRow('CMYK').value).toMatch(/^cmyk\(/);
  });

  it('follows what is typed, in any of the formats, and announces it when the field is left', async () => {
    const field = await type(user, 'Colour', 'hsl(120, 100%, 50%)');
    expect(formatRow('HEX').value).toBe('#00ff00');
    expect(formatRow('RGB').value).toBe('rgb(0, 255, 0)');
    expect(statusText()).not.toContain('Colour set');
    await user.tab();
    expect(statusText()).toContain('Colour set to #00ff00');
    expect(field.getAttribute('aria-invalid')).toBeNull();

    await type(user, 'Colour', 'cmyk(0, 100, 100, 0)');
    expect(formatRow('HEX').value).toBe('#ff0000');
    await type(user, 'Colour', 'oklch(100% 0 0)');
    expect(formatRow('HEX').value).toBe('#ffffff');
    await type(user, 'Colour', 'F80');
    expect(formatRow('HEX').value).toBe('#ff8800');
  });

  it('keeps the last good colour and says what is wrong while the text is not a colour', async () => {
    const field = await type(user, 'Colour', 'rgb(1, 2, 3)');
    expect(formatRow('HEX').value).toBe('#010203');
    await type(user, 'Colour', 'rgb(1, 2');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/not a colour I know/)).toBeTruthy();
    expect(formatRow('HEX').value).toBe('#010203');
    await user.tab();
    expect(statusText()).toContain('This is not a colour I know');

    await type(user, 'Colour', 'rgb(300, 0, 0)');
    expect(screen.getByText('A value is outside its range.')).toBeTruthy();
    await type(user, 'Colour', 'rgb(1 2)');
    expect(screen.getByText(/wrong number of values/)).toBeTruthy();
    await type(user, 'Colour', '#ff000080');
    expect(screen.getByText(/Transparent colours are not supported/)).toBeTruthy();
    await type(user, 'Colour', '');
    expect(screen.getByText('Enter a colour.')).toBeTruthy();

    await type(user, 'Colour', '#00f');
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(formatRow('HEX').value).toBe('#0000ff');
  });

  it('takes a colour from the colour picker', async () => {
    const picker = screen.getByLabelText<HTMLInputElement>('Pick a colour');
    expect(picker.type).toBe('color');
    expect(picker.value).toBe('#3a7bd5');
    await fireEvent.input(picker, { target: { value: '#ff0000' } });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Colour' }).value).toBe('#ff0000');
    expect(formatRow('RGB').value).toBe('rgb(255, 0, 0)');
    await fireEvent.change(picker);
    expect(statusText()).toContain('Colour set to #ff0000');
    // A value the picker would never send changes nothing.
    await fireEvent.input(picker, { target: { value: '#00ff00' } });
    expect(formatRow('HEX').value).toBe('#00ff00');
  });

  it('tells when an OKLCH colour had to be moved into the sRGB range', async () => {
    expect(screen.queryByText(/outside the sRGB range/)).toBeNull();
    await type(user, 'Colour', 'oklch(70% 0.4 150)');
    expect(screen.getByText(/outside the sRGB range/)).toBeTruthy();
    await type(user, 'Colour', '#123456');
    expect(screen.queryByText(/outside the sRGB range/)).toBeNull();
  });

  it('copies a format and confirms it in the toast region', async () => {
    await user.click(formatRow('HEX').copy);
    expect(await navigator.clipboard.readText()).toBe('#3a7bd5');
    const region = screen.getByRole('region', { name: 'Notifications' });
    await waitFor(() => {
      expect(region.textContent).toContain('Copied #3a7bd5');
    });
    await user.click(formatRow('RGB').copy);
    expect(await navigator.clipboard.readText()).toBe('rgb(58, 123, 213)');
  });

  it('says so when the clipboard refuses', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(formatRow('HEX').copy);
    const region = screen.getByRole('region', { name: 'Notifications' });
    await waitFor(() => {
      expect(region.textContent).toContain('Could not copy');
    });
  });
});

describe('contrast', () => {
  let user: User;

  beforeEach(async () => {
    user = userEvent.setup();
    await openTool(manifest);
  });

  function row(name: string): string {
    const header = screen.getByRole('rowheader', { name });
    return header.closest('tr')?.textContent ?? '';
  }

  it('starts with dark text on white and shows ratio and every requirement', () => {
    expect(screen.getByText(/^Contrast ratio \d+(\.\d+)?:1$/)).toBeTruthy();
    expect(row('AA, normal text')).toContain('4.5:1');
    expect(row('AA, normal text')).toContain('Pass');
    expect(row('AAA, normal text')).toContain('7:1');
    expect(row('AA, large text')).toContain('3:1');
    expect(row('AAA, large text')).toContain('4.5:1');
    expect(row('AA, interface parts and graphics')).toContain('3:1');
    expect(screen.getByRole('table', { name: 'WCAG 2.2 requirements' })).toBeTruthy();
  });

  it('computes the ratio and the verdicts from what is typed, and announces them', async () => {
    await type(user, 'Text colour', '#777777');
    await type(user, 'Background colour', '#ffffff');
    expect(screen.getByText('Contrast ratio 4.47:1')).toBeTruthy();
    expect(row('AA, normal text')).toContain('Fail');
    expect(row('AA, large text')).toContain('Pass');
    expect(row('AAA, normal text')).toContain('Fail');
    await user.tab();
    expect(statusText()).toContain(
      'Contrast ratio 4.47:1. Normal text AA: Fail. Large text AA: Pass. Normal text AAA: Fail.',
    );

    await type(user, 'Text colour', '#767676');
    expect(screen.getByText('Contrast ratio 4.54:1')).toBeTruthy();
    expect(row('AA, normal text')).toContain('Pass');
    await type(user, 'Text colour', '#000');
    expect(screen.getByText('Contrast ratio 21:1')).toBeTruthy();
    expect(row('AAA, normal text')).toContain('Pass');
  });

  it('keeps the last good colours while a field holds no colour, and announces the problem', async () => {
    await type(user, 'Text colour', '#000000');
    await type(user, 'Background colour', 'nonsense');
    expect(screen.getByText('Contrast ratio 21:1')).toBeTruthy();
    await user.tab();
    expect(statusText()).toContain('This is not a colour I know');
    await type(user, 'Text colour', '');
    await user.tab();
    expect(statusText()).toContain('Enter a colour.');
  });

  it('takes the colour from above as text or as background colour, and swaps the two', async () => {
    await type(user, 'Colour', '#ff0000');
    await user.click(screen.getByRole('button', { name: 'Use the colour above as text colour' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Text colour' }).value).toBe(
      '#ff0000',
    );
    expect(statusText()).toContain('Contrast ratio');
    await user.click(
      screen.getByRole('button', { name: 'Use the colour above as background colour' }),
    );
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Background colour' }).value).toBe(
      '#ff0000',
    );
    expect(screen.getByText('Contrast ratio 1:1')).toBeTruthy();

    await type(user, 'Text colour', '#00ff00');
    await user.click(screen.getByRole('button', { name: 'Swap colours' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Text colour' }).value).toBe(
      '#ff0000',
    );
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Background colour' }).value).toBe(
      '#00ff00',
    );
  });

  it('has colour pickers for both colours', async () => {
    const text = screen.getByLabelText<HTMLInputElement>('Pick the text colour');
    const background = screen.getByLabelText<HTMLInputElement>('Pick the background colour');
    await fireEvent.input(text, { target: { value: '#000000' } });
    await fireEvent.input(background, { target: { value: '#ffffff' } });
    await fireEvent.change(background);
    expect(screen.getByText('Contrast ratio 21:1')).toBeTruthy();
    expect(statusText()).toContain('Contrast ratio 21:1');
  });

  it('shows a sample of the two colours that screen readers skip, in the colours chosen', async () => {
    const sample = document.querySelector<HTMLElement>('.sample');
    expect(sample?.getAttribute('aria-hidden')).toBe('true');
    expect(sample?.getAttribute('data-sample')).toBe('Sample text');
    expect(sample?.textContent).toBe('');
    const user = userEvent.setup();
    await type(user, 'Text colour', '#ff0000');
    await type(user, 'Background colour', '#00ff00');
    expect(sample?.style.color).toBe('rgb(255, 0, 0)');
    expect(sample?.style.background).toBe('rgb(0, 255, 0)');
  });
});

describe('palette from an image', () => {
  type Rgba = readonly [number, number, number, number];

  /** A browser whose decoder returns an image made by `colorOf`, 4 x 4 pixels. */
  function stubImage(options: {
    colorOf?: (index: number) => Rgba;
    decode?: Promise<unknown> | 'fail';
  }): void {
    const colorOf =
      options.colorOf ??
      ((index: number): Rgba => (index < 12 ? [200, 30, 30, 255] : [20, 40, 220, 255]));
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => {
        if (options.decode === 'fail') {
          return Promise.reject(new Error('not an image'));
        }
        return (options.decode ?? Promise.resolve(undefined)).then(() => ({
          width: 4,
          height: 4,
          close: vi.fn(),
        }));
      }),
    );
    class FakeCanvas {
      getContext(): unknown {
        return {
          drawImage: vi.fn(),
          getImageData: (_x: number, _y: number, width: number, height: number) => {
            const data = new Uint8ClampedArray(width * height * 4);
            for (let index = 0; index < width * height; index += 1) {
              data.set(colorOf(index), index * 4);
            }
            return { data };
          },
        };
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  }

  function chooseFile(file: File): Promise<boolean> {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) {
      throw new Error('no file input');
    }
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    return fireEvent.change(input);
  }

  const picture = (name = 'logo.png'): File => new File(['x'], name, { type: 'image/png' });

  function paletteHexes(): string[] {
    const list = screen.queryByRole('list', { name: /^Colours of / });
    return list === null
      ? []
      : within(list)
          .getAllByText(/^#[0-9a-f]{6}$/)
          .map((c) => c.textContent);
  }

  beforeEach(async () => {
    await openTool(manifest);
  });

  it('offers a file chooser and an empty palette at first', () => {
    expect(screen.getByRole('button', { name: 'Choose an image' })).toBeTruthy();
    expect(screen.getByText('Drop an image here')).toBeTruthy();
    expect(paletteHexes()).toEqual([]);
    expect(document.querySelector<HTMLInputElement>('input[type="file"]')?.accept).toBe('image/*');
  });

  it('lists the colours of the image, largest first, with their share, and announces it', async () => {
    stubImage({});
    await chooseFile(picture());
    await waitFor(() => {
      expect(paletteHexes()).toEqual(['#c81e1e', '#1428dc']);
    });
    expect(screen.getByText('75 % of the image')).toBeTruthy();
    expect(screen.getByText('25 % of the image')).toBeTruthy();
    expect(statusText()).toContain('Palette ready: 2 colours from logo.png');
    expect(screen.getByRole('list', { name: 'Colours of logo.png' })).toBeTruthy();
  });

  it('says "1 colour" for a one-colour image', async () => {
    stubImage({ colorOf: () => [9, 9, 9, 255] });
    await chooseFile(picture('grey.png'));
    await waitFor(() => {
      expect(statusText()).toContain('Palette ready: 1 colour from grey.png');
    });
  });

  it('uses a colour of the palette as the colour, and copies it', async () => {
    const user = userEvent.setup();
    stubImage({});
    await chooseFile(picture());
    await waitFor(() => {
      expect(paletteHexes()).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'Use #1428dc as the colour' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Colour' }).value).toBe('#1428dc');
    expect(statusText()).toContain('Colour set to #1428dc');
    await user.click(screen.getByRole('button', { name: 'Copy #c81e1e' }));
    expect(await navigator.clipboard.readText()).toBe('#c81e1e');
  });

  it('follows the number of colours', async () => {
    const user = userEvent.setup();
    stubImage({
      colorOf: (index) => [index * 16, 255 - index * 16, (index * 40) % 256, 255],
    });
    await chooseFile(picture());
    await waitFor(() => {
      expect(paletteHexes()).toHaveLength(6);
    });
    const count = screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Number of colours' });
    expect(count.value).toBe('6');
    await user.clear(count);
    await user.type(count, '3');
    await waitFor(() => {
      expect(paletteHexes()).toHaveLength(3);
    });
    await user.tab();
    expect(statusText()).toContain('Palette ready: 3 colours from logo.png');
    await user.clear(count);
    await user.type(count, '99');
    await waitFor(() => {
      expect(paletteHexes().length).toBeGreaterThan(6);
    });
    expect(paletteHexes().length).toBeLessThanOrEqual(12);
  });

  it('does not announce a palette for the number of colours before an image is chosen', async () => {
    const user = userEvent.setup();
    const count = screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Number of colours' });
    await user.clear(count);
    await user.type(count, '4');
    await user.tab();
    expect(statusText()).not.toContain('Palette ready');
  });

  it('reports a file that is not an image', async () => {
    stubImage({ decode: 'fail' });
    await chooseFile(picture('broken.png'));
    await waitFor(() => {
      expect(problemText()).toBe('This file could not be read as an image.');
    });
    expect(paletteHexes()).toEqual([]);
  });

  it('refuses an image over 50 MB without decoding it', async () => {
    stubImage({});
    const huge = picture('huge.png');
    Object.defineProperty(huge, 'size', { value: 50 * 1024 * 1024 + 1 });
    await chooseFile(huge);
    await waitFor(() => {
      expect(problemText()).toBe('This image is larger than 50 MB.');
    });
    expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
  });

  it('reports an image without visible pixels', async () => {
    stubImage({ colorOf: () => [0, 0, 0, 0] });
    await chooseFile(picture('clear.png'));
    await waitFor(() => {
      expect(problemText()).toBe('This image has no visible pixels.');
    });
    expect(paletteHexes()).toEqual([]);
  });

  it('clears an error when the next image works', async () => {
    stubImage({ decode: 'fail' });
    await chooseFile(picture('broken.png'));
    await waitFor(() => {
      expect(problemText()).not.toBe('');
    });
    stubImage({});
    await chooseFile(picture());
    await waitFor(() => {
      expect(paletteHexes()).toHaveLength(2);
    });
    expect(problemText()).toBe('');
  });

  it('refuses a dropped file that is no image', async () => {
    const group = screen.getByText('Drop an image here').closest('[role="group"]');
    if (group === null) {
      throw new Error('no drop zone');
    }
    const text = new File(['x'], 'notes.txt', { type: 'text/plain' });
    await fireEvent.drop(group, { dataTransfer: { files: [text] } });
    expect(problemText()).toBe('Only images can be used here.');
  });

  it('shows only the newest image when two are read at once', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubImage({ decode: slow, colorOf: () => [250, 0, 0, 255] });
    await chooseFile(picture('slow.png'));
    stubImage({ colorOf: () => [0, 250, 0, 255] });
    await chooseFile(picture('fast.png'));
    await waitFor(() => {
      expect(paletteHexes()).toEqual(['#00fa00']);
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(paletteHexes()).toEqual(['#00fa00']);
    expect(screen.getByRole('list', { name: 'Colours of fast.png' })).toBeTruthy();
  });

  it('ignores a failure of an image that is no longer the newest', async () => {
    let fail: (reason: Error) => void = () => undefined;
    const slow = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    stubImage({ decode: slow });
    await chooseFile(picture('slow.png'));
    stubImage({ colorOf: () => [0, 250, 0, 255] });
    await chooseFile(picture('fast.png'));
    await waitFor(() => {
      expect(paletteHexes()).toEqual(['#00fa00']);
    });
    fail(new Error('late'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(problemText()).toBe('');
    expect(paletteHexes()).toEqual(['#00fa00']);
  });
});

describe('in German', () => {
  it('shows the German texts and the same colours', async () => {
    await openTool(manifest);
    i18n.setLocale('de');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Farbwähler');
    });
    expect(screen.getByRole('heading', { level: 2, name: 'Formate' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Kontrast' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'HEX kopieren' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Farbe' })).toBeTruthy();
  });
});
