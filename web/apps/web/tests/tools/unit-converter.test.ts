import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/unit-converter/manifest.ts';
import { toaster } from '../../src/ui/toast.svelte.ts';
import { openTool } from '../tool-helpers.ts';
import { fieldErrorText } from '../helpers.ts';

type User = ReturnType<typeof userEvent.setup>;

afterEach(() => {
  toaster.clear();
  vi.restoreAllMocks();
  i18n.setLocale('en');
});

describe('unit-converter', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/unit-converter with exactly one heading: its name', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/unit-converter');
    expect(view.headings).toEqual(['Unit converter']);
    expect(view.main.textContent).toContain('Your files stay in this browser');
  });

  it('is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.searchHits('unit converter')).toEqual(['unit-converter']);
    expect(view.searchHits('fahrenheit')).toEqual([]);
    expect(view.searchHits('temperature')).toEqual(['unit-converter']);
  });
});

function field(name: string): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('textbox', { name });
}

function select(name: string): HTMLSelectElement {
  return screen.getByRole<HTMLSelectElement>('combobox', { name });
}

async function setValue(user: User, text: string): Promise<void> {
  const input = field('Value');
  await user.clear(input);
  if (text !== '') {
    await user.type(input, text);
  }
}

/** The big result: number and symbol. */
function result(): string {
  return document.querySelector('.equation')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
}

function statusText(): string {
  return screen
    .getAllByRole('status')
    .map((region) => region.textContent.trim())
    .join('|');
}

function problemShown(): string | null {
  return fieldErrorText();
}

/** The "all units" table as unit id to value text, keyed by the name in the first column. */
function table(): Map<string, string> {
  const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
  return new Map(
    rows.map((row) => [
      within(row).getByRole('rowheader').textContent,
      within(row).getAllByRole('cell')[1]?.textContent ?? '',
    ]),
  );
}

describe('converting', () => {
  let user: User;

  beforeEach(async () => {
    user = userEvent.setup();
    await openTool(manifest);
  });

  it('starts with one kilometre in miles', () => {
    expect(select('Category').value).toBe('length');
    expect(select('From').value).toBe('km');
    expect(select('To').value).toBe('mi');
    expect(field('Value').value).toBe('1');
    expect(result()).toBe('0.621371 mi');
    expect(problemShown()).toBeNull();
  });

  it('converts while typing and announces the result when the field is left', async () => {
    await setValue(user, '100');
    expect(result()).toBe('62.1371 mi');
    expect(statusText()).not.toContain('Kilometre');
    await user.tab();
    expect(statusText()).toContain('100 Kilometre = 62.1371 Mile');
  });

  it('reads a decimal comma and groups of digits', async () => {
    await setValue(user, '2,5');
    expect(result()).toBe('1.55343 mi');
    await setValue(user, '1 000');
    expect(result()).toBe('621.371 mi');
    await setValue(user, '-5');
    expect(result()).toBe('-3.10686 mi');
    await setValue(user, '1e3');
    expect(result()).toBe('621.371 mi');
  });

  it('lists the value in every unit of the category', () => {
    const values = table();
    expect([...values.keys()]).toEqual([
      'Nanometre',
      'Micrometre',
      'Millimetre',
      'Centimetre',
      'Metre',
      'Kilometre',
      'Inch',
      'Foot',
      'Yard',
      'Mile',
      'Nautical mile',
    ]);
    expect(values.get('Metre')).toBe('1000');
    expect(values.get('Foot')).toBe('3280.84');
    expect(values.get('Kilometre')).toBe('1');
  });

  it('changes the units, and announces the change', async () => {
    await user.selectOptions(select('To'), 'ft');
    expect(result()).toBe('3280.84 ft');
    expect(statusText()).toContain('1 Kilometre = 3280.84 Foot');
    await user.selectOptions(select('From'), 'mi');
    expect(result()).toBe('5280 ft');
    expect(statusText()).toContain('1 Mile = 5280 Foot');
  });

  it('swaps the two units', async () => {
    await user.click(screen.getByRole('button', { name: 'Swap units' }));
    expect(select('From').value).toBe('mi');
    expect(select('To').value).toBe('km');
    expect(result()).toBe('1.60934 km');
    expect(statusText()).toContain('1 Mile = 1.60934 Kilometre');
  });

  it('goes to the default units of another category', async () => {
    await user.selectOptions(select('Category'), 'temperature');
    expect(select('From').value).toBe('c');
    expect(select('To').value).toBe('f');
    expect(result()).toBe('33.8 °F');
    await setValue(user, '100');
    expect(result()).toBe('212 °F');
    await setValue(user, '-40');
    expect(result()).toBe('-40 °F');
    await setValue(user, '0');
    await user.selectOptions(select('From'), 'k');
    expect(select('Category').value).toBe('temperature');
    expect(result()).toBe('-459.67 °F');
  });

  it('knows binary and decimal data units apart', async () => {
    await user.selectOptions(select('Category'), 'data');
    expect(select('From').value).toBe('gb');
    expect(select('To').value).toBe('gib');
    expect(result()).toBe('0.931323 GiB');
    await user.selectOptions(select('From'), 'gib');
    await user.selectOptions(select('To'), 'byte');
    expect(result()).toBe('1073740000 B');
    expect(screen.getByText(/count in thousands/)).toBeTruthy();
  });

  it('shows the note of the categories that have one, and no other', async () => {
    expect(screen.queryByText(/count in thousands|365\.25|US measures/)).toBeNull();
    await user.selectOptions(select('Category'), 'time');
    expect(screen.getByText('A year is 365.25 days.')).toBeTruthy();
    await user.selectOptions(select('Category'), 'volume');
    expect(screen.getByText(/US measures/)).toBeTruthy();
    await user.selectOptions(select('Category'), 'speed');
    expect(screen.queryByText(/US measures|365\.25/)).toBeNull();
  });

  it('offers every category of the issue', () => {
    expect(
      within(select('Category'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Length', 'Mass', 'Temperature', 'Data', 'Time', 'Speed', 'Area', 'Volume']);
  });

  it('copies the result and confirms it', async () => {
    await user.click(screen.getByRole('button', { name: 'Copy result' }));
    expect(await navigator.clipboard.readText()).toBe('0.621371');
    const region = screen.getByRole('region', { name: 'Notifications' });
    await waitFor(() => {
      expect(region.textContent).toContain('Copied 0.621371 mi');
    });
  });

  it('says so when the clipboard refuses', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy result' }));
    const region = screen.getByRole('region', { name: 'Notifications' });
    await waitFor(() => {
      expect(region.textContent).toContain('Could not copy');
    });
  });
});

describe('precision', () => {
  let user: User;

  beforeEach(async () => {
    user = userEvent.setup();
    await openTool(manifest);
  });

  async function setPrecision(text: string): Promise<void> {
    const input = screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Significant digits' });
    await user.clear(input);
    if (text !== '') {
      await user.type(input, text);
    }
  }

  it('starts with six significant digits and says what the range is', () => {
    const input = screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Significant digits' });
    expect(input.value).toBe('6');
    expect(input.min).toBe('1');
    expect(input.max).toBe('15');
    expect(screen.getByText('From 1 to 15.')).toBeTruthy();
  });

  it('rounds to the digits chosen, in the result and in the table', async () => {
    await setPrecision('3');
    expect(result()).toBe('0.621 mi');
    expect(table().get('Foot')).toBe('3280');
    await setPrecision('15');
    expect(result()).toBe('0.621371192237334 mi');
    await setPrecision('1');
    expect(result()).toBe('0.6 mi');
  });

  it('keeps to the range and falls back to six when the field is empty', async () => {
    await setPrecision('99');
    expect(result()).toBe('0.621371192237334 mi');
    await setPrecision('');
    expect(result()).toBe('0.621371 mi');
    await setPrecision('0');
    expect(result()).toBe('0.6 mi');
  });

  it('announces the result again when the precision is committed', async () => {
    await setPrecision('2');
    await user.tab();
    expect(statusText()).toContain('1 Kilometre = 0.62 Mile');
  });
});

describe('what cannot be converted', () => {
  let user: User;

  beforeEach(async () => {
    user = userEvent.setup();
    await openTool(manifest);
  });

  it.each([
    ['', 'Enter a value.'],
    ['abc', 'This is not a number. Use digits with one dot or comma, for example 12.5.'],
    ['1.2.3', 'This is not a number. Use digits with one dot or comma, for example 12.5.'],
    ['1e999', 'This number is too large.'],
  ])('refuses %j with a message', async (text, message) => {
    await setValue(user, text);
    expect(problemShown()).toBe(message);
    expect(field('Value').getAttribute('aria-invalid')).toBe('true');
    expect(result()).toBe('—');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy result' })).toBeNull();
    await user.tab();
    expect(statusText()).toContain(message);
  });

  it('recovers when the value is a number again', async () => {
    await setValue(user, 'abc');
    expect(problemShown()).not.toBeNull();
    await setValue(user, '3');
    expect(problemShown()).toBeNull();
    expect(result()).toBe('1.86411 mi');
  });

  it('refuses a temperature below absolute zero', async () => {
    await user.selectOptions(select('Category'), 'temperature');
    await setValue(user, '-273.16');
    expect(problemShown()).toBe('This is below absolute zero.');
    expect(screen.queryByRole('table')).toBeNull();
    await setValue(user, '-273.15');
    expect(problemShown()).toBeNull();
    expect(result()).toBe('-459.67 °F');
    await user.selectOptions(select('From'), 'f');
    await setValue(user, '-459.68');
    expect(problemShown()).toBe('This is below absolute zero.');
  });

  it('refuses a result too large to show', async () => {
    await user.selectOptions(select('To'), 'nm');
    await setValue(user, '1e300');
    expect(problemShown()).toBe('The result is too large to show.');
  });

  it('writes a dash for a unit whose value overflows, and the rest of the table stays', async () => {
    await setValue(user, '1e300');
    expect(problemShown()).toBeNull();
    expect(result()).toBe('6.21371e+299 mi');
    expect(table().get('Nanometre')).toBe('—');
    expect(table().get('Metre')).toBe('1e+303');
  });
});

describe('finding a unit', () => {
  let user: User;

  beforeEach(async () => {
    user = userEvent.setup();
    await openTool(manifest);
  });

  async function search(text: string): Promise<void> {
    const input = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Find a unit' });
    await user.clear(input);
    if (text !== '') {
      await user.type(input, text);
    }
  }

  function hitNames(): string[] {
    const list = screen.queryByRole('list', { name: 'Matching units' });
    return list === null
      ? []
      : within(list)
          .getAllByRole('listitem')
          .map((item) => item.querySelector('.hit-name')?.textContent ?? '');
  }

  it('lists nothing until something is typed', () => {
    expect(hitNames()).toEqual([]);
    expect(screen.queryByRole('list', { name: 'Matching units' })).toBeNull();
    expect(screen.getByText('Name, symbol or category, in English or German')).toBeTruthy();
  });

  it('finds units by name or symbol and counts them in a status region', async () => {
    await search('mile');
    expect(hitNames()[0]).toBe('Mile (mi)');
    expect(statusText()).toMatch(/\d+ units? found/);
    await search('GiB');
    expect(hitNames()).toEqual(['Gibibyte (GiB)']);
    expect(statusText()).toContain('1 unit found');
  });

  it('says when nothing matches, and clears when the field is emptied', async () => {
    await search('zzzzzz');
    expect(hitNames()).toEqual([]);
    expect(statusText()).toContain('No unit found');
    await search('');
    expect(statusText()).not.toContain('No unit found');
  });

  it('sets the unit to convert to', async () => {
    await search('foot');
    await user.click(screen.getByRole('button', { name: 'Use Foot as the unit to convert to' }));
    expect(select('Category').value).toBe('length');
    expect(select('From').value).toBe('km');
    expect(select('To').value).toBe('ft');
    expect(result()).toBe('3280.84 ft');
    expect(statusText()).toContain('1 Kilometre = 3280.84 Foot');
  });

  it('sets the unit to convert from, and switches the category when it is another one', async () => {
    await search('pound');
    await user.click(screen.getByRole('button', { name: 'Use Pound as the unit to convert from' }));
    expect(select('Category').value).toBe('mass');
    expect(select('From').value).toBe('lb');
    expect(select('To').value).toBe('lb');
    expect(result()).toBe('1 lb');
    await search('gram');
    await user.click(screen.getByRole('button', { name: 'Use Gram as the unit to convert to' }));
    expect(select('To').value).toBe('g');
    expect(result()).toBe('453.592 g');
  });

  it('finds the German names too', async () => {
    await search('Meile');
    expect(hitNames()[0]).toBe('Mile (mi)');
  });
});

describe('in German', () => {
  it('shows German texts, unit names and the decimal comma', async () => {
    const user = userEvent.setup();
    await openTool(manifest);
    i18n.setLocale('de');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Einheitenumrechner');
    });
    expect(select('Kategorie').value).toBe('length');
    expect(
      within(select('Kategorie'))
        .getAllByRole('option')
        .map((option) => option.textContent)[0],
    ).toBe('Länge');
    expect(result()).toBe('0,621371 mi');
    expect(within(select('Von')).getByRole('option', { name: 'Kilometer (km)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ergebnis kopieren' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Ergebnis kopieren' }));
    expect(await navigator.clipboard.readText()).toBe('0,621371');
  });
});
