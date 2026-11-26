import { cleanup, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IEEE_REGISTRATION_AUTHORITY_TEXT,
  IEEE_REGISTRATION_AUTHORITY_URL,
} from '../../src/app/external-links.ts';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/mac/manifest.ts';
import type * as MacTask from '../../src/tools/mac/task.ts';
import { runTask, type Input } from '../../src/tools/mac/task.ts';
import { toast } from '@mozra-the-great/kern';
import { openTool } from '../tool-helpers.ts';
import { SAMPLE_MA_L, SAMPLE_MA_M, SAMPLE_MA_S, csvFile } from './mac-fixtures.ts';

type User = ReturnType<typeof userEvent.setup>;
type Behaviour = 'real' | 'hang' | 'fail';

const pool = vi.hoisted(() => ({
  behaviour: 'real',
  created: 0,
  terminated: 0,
  jobs: [] as unknown[],
  run: undefined as unknown as (input: unknown, options: unknown) => Promise<unknown>,
}));

vi.mock('../../src/tools/mac/pool.ts', () => ({
  createPool: () => {
    pool.created += 1;
    return {
      run: (input: unknown, options: unknown) => pool.run(input, options),
      terminate: () => {
        pool.terminated += 1;
      },
    };
  },
}));

// A short limit, so the test of the time-out does not need half a minute.
vi.mock('../../src/tools/mac/task.ts', async (importOriginal) => {
  const original = await importOriginal<typeof MacTask>();
  return { ...original, LOAD_TIMEOUT_MS: 300 };
});

function setBehaviour(behaviour: Behaviour): void {
  pool.behaviour = behaviour;
}

beforeEach(() => {
  vi.stubGlobal(
    'Worker',
    class FakeWorker {
      readonly terminate = vi.fn();
    },
  );
  pool.behaviour = 'real';
  pool.created = 0;
  pool.terminated = 0;
  pool.jobs = [];
  pool.run = (input, options) => {
    pool.jobs.push(input);
    const { signal } = options as { signal: AbortSignal };
    if (pool.behaviour === 'fail') {
      return Promise.reject(new Error('boom'));
    }
    if (pool.behaviour === 'hang') {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      });
    }
    return runTask(input as Input, { progress: () => undefined });
  };
});

afterEach(() => {
  toast.clear();
  vi.unstubAllGlobals();
  i18n.setLocale('en');
});

const INPUT = 'MAC addresses';

async function open(): Promise<User> {
  const user = userEvent.setup();
  await openTool(manifest);
  return user;
}

function field(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: INPUT });
}

async function enter(user: User, text: string): Promise<void> {
  await user.clear(field());
  await user.click(field());
  if (text !== '') {
    await user.paste(text);
  }
  await user.tab();
}

function statusText(): string {
  return document.querySelector('main .tool-status:not(.alert)')?.textContent.trim() ?? '';
}

function alertText(): string {
  return document.querySelector('main .tool-status.alert')?.textContent.trim() ?? '';
}

function fieldError(): string {
  const box = field();
  if (box.getAttribute('aria-invalid') !== 'true') {
    return '';
  }
  return (box.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id.endsWith('-error'))
    .map((id) => document.getElementById(id)?.textContent.trim() ?? '')
    .join(' ');
}

/** The rows of the detail table: the label and the value of each. */
function properties(): Record<string, string> {
  return Object.fromEntries(
    screen
      .getAllByRole('row')
      .slice(1)
      .filter((row) => within(row).queryByRole('rowheader') !== null)
      .map((row) => [
        within(row).getByRole('rowheader').textContent,
        within(row).getAllByRole('cell')[0]?.textContent ?? '',
      ]),
  );
}

function listRows(): string[][] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    );
}

function filePicker(): HTMLInputElement {
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (picker === null) {
    throw new Error('no file input');
  }
  return picker;
}

async function chooseFiles(user: User, ...files: File[]): Promise<void> {
  await user.upload(filePicker(), files);
}

describe('mac', () => {
  it('keeps the privacy promise in its manifest and needs a worker', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
    expect(manifest.requires).toContain('worker');
    expect(manifest.category).toBe('network');
  });

  it('opens at /tools/mac with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/mac');
    expect(view.headings).toEqual(['MAC address']);
    expect(view.searchHits('oui')).toEqual(['mac']);
    expect(view.searchHits('hersteller')).toEqual(['mac']);
  });

  it('ships no vendor data and starts no worker before a list is chosen', async () => {
    await open();
    expect(pool.created).toBe(0);
    expect(manifest.budget.assetsKb).toBe(0);
  });
});

describe('one address', () => {
  it('shows the documentation address of RFC 7042 in every spelling when it opens', async () => {
    await open();
    expect(properties()).toEqual({
      Kind: 'EUI-48',
      'Colon, lower case': '00:00:5e:00:53:01',
      'Colon, upper case': '00:00:5E:00:53:01',
      'Dash, upper case (IEEE)': '00-00-5E-00-53-01',
      'Dots (Cisco)': '0000.5e00.5301',
      'No separator, lower case': '00005e005301',
      'No separator, upper case': '00005E005301',
      Transmission: 'Unicast',
      Administration: 'Universal',
      'OUI prefix': '00-00-5E',
      Vendor: 'No vendor list loaded. Choose the IEEE lists below.',
      'IPv6 link-local address built from it (EUI-64 method)': 'fe80::200:5eff:fe00:5301',
    });
    expect(screen.getByText('Unicast: sent to one device.')).toBeDefined();
    expect(screen.getByText(/Universally administered: the IEEE assigned/)).toBeDefined();
  });

  it('reads another spelling and announces the kind of address', async () => {
    const user = await open();
    await enter(user, '02-1A-2B-3C-4D-5E');
    expect(properties()['Colon, lower case']).toBe('02:1a:2b:3c:4d:5e');
    expect(properties()['Administration']).toBe('Local');
    expect(screen.getByText(/Locally administered: set by the system/)).toBeDefined();
    expect(statusText()).toBe('02:1a:2b:3c:4d:5e: Unicast, Local.');
  });

  it('shows a multicast address, and names the two multicast ranges and broadcast', async () => {
    const user = await open();
    await enter(user, '01:00:5e:00:00:fb');
    expect(properties()['Transmission']).toBe('Multicast');
    expect(screen.getByText('Multicast: sent to a group of devices.')).toBeDefined();
    expect(screen.getByText(/multicast address of an IPv4 multicast group/)).toBeDefined();
    await enter(user, '33:33:00:00:00:01');
    expect(screen.getByText(/multicast address of an IPv6 multicast group/)).toBeDefined();
    await enter(user, 'ff:ff:ff:ff:ff:ff');
    expect(properties()['Transmission']).toBe('Broadcast');
    expect(screen.getByText('Broadcast: sent to every device on the link.')).toBeDefined();
    expect(screen.queryByText(/multicast address of an IPv/)).toBeNull();
  });

  it('reads an EUI-64', async () => {
    const user = await open();
    await enter(user, '34:56:78:ff:fe:9a:bc:de');
    expect(properties()).toMatchObject({
      Kind: 'EUI-64',
      'Dots (Cisco)': '3456.78ff.fe9a.bcde',
      'OUI prefix': '34-56-78',
      'IPv6 link-local address built from it (EUI-64 method)': 'fe80::3656:78ff:fe9a:bcde',
    });
  });

  it('says what is wrong, in the field and in the status', async () => {
    const user = await open();
    await enter(user, '00:1a:2b:3c:4d');
    expect(fieldError()).toBe('A MAC address has 12 hexadecimal digits (EUI-48) or 16 (EUI-64).');
    expect(screen.queryByRole('table')).toBeNull();
    expect(statusText()).toBe('A MAC address has 12 hexadecimal digits (EUI-48) or 16 (EUI-64).');
    await enter(user, '00:1a-2b:3c:4d:5e');
    expect(fieldError()).toBe('Use one kind of separator: colons, dashes or dots.');
    await enter(user, '');
    expect(screen.queryByRole('table')).toBeNull();
    expect(fieldError()).toBe('');
    expect(statusText()).toBe('');
  });

  it('copies a value and confirms it', async () => {
    const user = await open();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await user.click(screen.getByRole('button', { name: 'Copy Dash, upper case (IEEE)' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('00-00-5E-00-53-01');
    });
    expect(screen.queryByRole('button', { name: 'Copy Kind' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy Vendor' })).toBeNull();
  });
});

describe('several addresses', () => {
  it('lists them, with the reason for each one that cannot be read', async () => {
    const user = await open();
    await enter(user, '00:00:5e:00:53:01\nnot a mac\n01:00:5e:00:00:fb\r\n0200.5e00.5302\n');
    expect(listRows()).toEqual([
      ['00:00:5e:00:53:01', '00:00:5e:00:53:01', 'Unicast', 'Universal', '00-00-5E'],
      ['not a mac', 'A MAC address has only the digits 0 to 9 and the letters a to f.'],
      ['01:00:5e:00:00:fb', '01:00:5e:00:00:fb', 'Multicast', 'Universal', '01-00-5E'],
      ['0200.5e00.5302', '02:00:5e:00:53:02', 'Unicast', 'Local', '02-00-5E'],
    ]);
    expect(statusText()).toBe('3 of 4 addresses are valid.');
    expect(fieldError()).toBe('');
  });

  it('announces how many were read', async () => {
    const user = await open();
    await enter(user, '00:00:5e:00:53:01\n00:00:5e:00:53:02');
    expect(statusText()).toBe('2 addresses read.');
    expect(listRows()).toHaveLength(2);
  });

  it('a single wrong line is an error of the field, not a table', async () => {
    const user = await open();
    await enter(user, 'zz');
    expect(fieldError()).toBe('A MAC address has only the digits 0 to 9 and the letters a to f.');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('refuses a very long input and too many addresses', async () => {
    const user = await open();
    const many = Array.from({ length: 1001 }, () => '00:00:5e:00:53:01').join('\n');
    await user.clear(field());
    await user.click(field());
    await user.paste(many);
    await user.tab();
    expect(fieldError()).toBe('More than 1,000 addresses. Split the list.');
    expect(screen.queryByRole('table')).toBeNull();
    await user.clear(field());
    await user.click(field());
    await user.paste(' '.repeat(100_001));
    await user.tab();
    expect(fieldError()).toBe('The input is longer than 100,000 characters.');
  });
});

describe('vendor names from a list the visitor loads', () => {
  it('explains where the lists come from and links to the IEEE page as plain text', async () => {
    await open();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Vendor names (optional)' }),
    ).toBeDefined();
    const link = screen.getByRole('link', { name: IEEE_REGISTRATION_AUTHORITY_TEXT });
    expect(link.getAttribute('href')).toBe(IEEE_REGISTRATION_AUTHORITY_URL);
    expect(link.getAttribute('rel')).toBe('external noopener noreferrer');
    expect(screen.getByText(/stuffcloud ships no vendor list/)).toBeDefined();
    expect(screen.getByText(/read in this tab only/)).toBeDefined();
    expect(filePicker().accept).toBe('.csv,text/csv');
    expect(filePicker().multiple).toBe(true);
  });

  it('reads the chosen files and shows the vendor of an address', async () => {
    const user = await open();
    await enter(user, '00:a0:b0:12:34:56');
    expect(properties()['Vendor']).toBe('No vendor list loaded. Choose the IEEE lists below.');
    await chooseFiles(user, csvFile('oui.csv', SAMPLE_MA_L), csvFile('mam.csv', SAMPLE_MA_M));
    await waitFor(() => {
      expect(statusText()).toBe('Vendor list loaded: 4 entries. It stays in this tab.');
    });
    expect(properties()['Vendor']).toBe('Example Networks Ltd (MA-L 00A0B0)');
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'oui.csv: entries read: 3',
      'mam.csv: entries read: 1',
    ]);
    expect(pool.created).toBe(1);
    expect(pool.jobs).toHaveLength(1);
  });

  it('finds the vendor by the longest assignment, and says when there is none', async () => {
    const user = await open();
    await chooseFiles(
      user,
      csvFile('oui.csv', SAMPLE_MA_L),
      csvFile('mam.csv', SAMPLE_MA_M),
      csvFile('oui36.csv', SAMPLE_MA_S),
    );
    await waitFor(() => {
      expect(statusText()).toMatch(/^Vendor list loaded: 5 entries/);
    });
    await enter(user, '1c:2d:3e:4f:00:01');
    expect(properties()['Vendor']).toBe('Medium Block Co (MA-M 1C2D3E4)');
    await enter(user, '8c:1f:64:ab:c1:00');
    expect(properties()['Vendor']).toBe('Small Block Co (MA-S 8C1F64ABC)');
    await enter(user, '00:00:5e:00:53:01');
    expect(properties()['Vendor']).toBe('Not in the loaded lists');
    await enter(user, '02:a0:b0:00:00:00');
    expect(properties()['Vendor']).toBe(
      'None: a locally administered address is not a vendor’s assignment',
    );
  });

  it('adds a vendor column to the list of addresses', async () => {
    const user = await open();
    await enter(user, '00:a0:b0:00:00:01\nzz\n04:d5:e6:00:00:02\n00:00:5e:00:53:01');
    expect(listRows()[0]).toHaveLength(5);
    await chooseFiles(user, csvFile('oui.csv', SAMPLE_MA_L));
    await waitFor(() => {
      expect(statusText()).toMatch(/^Vendor list loaded: 3 entries/);
    });
    expect(screen.getByRole('columnheader', { name: 'Vendor' })).toBeDefined();
    expect(listRows()).toEqual([
      [
        '00:a0:b0:00:00:01',
        '00:a0:b0:00:00:01',
        'Unicast',
        'Universal',
        '00-A0-B0',
        'Example Networks Ltd (MA-L 00A0B0)',
      ],
      ['zz', 'A MAC address has only the digits 0 to 9 and the letters a to f.'],
      [
        '04:d5:e6:00:00:02',
        '04:d5:e6:00:00:02',
        'Unicast',
        'Universal',
        '04-D5-E6',
        'Sample "Quoted" Devices, Inc. (MA-L 04D5E6)',
      ],
      [
        '00:00:5e:00:53:01',
        '00:00:5e:00:53:01',
        'Unicast',
        'Universal',
        '00-00-5E',
        'Not in the loaded lists',
      ],
    ]);
  });

  it('takes the vendor list away again', async () => {
    const user = await open();
    await chooseFiles(user, csvFile('oui.csv', SAMPLE_MA_L));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Remove the vendor list' })).not.toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Remove the vendor list' }));
    expect(statusText()).toBe('The vendor list was removed.');
    expect(screen.queryByRole('button', { name: 'Remove the vendor list' })).toBeNull();
    expect(properties()['Vendor']).toBe('No vendor list loaded. Choose the IEEE lists below.');
  });

  it('names the file that is not a vendor list, and keeps the list it had', async () => {
    const user = await open();
    await chooseFiles(user, csvFile('oui.csv', SAMPLE_MA_L));
    await waitFor(() => {
      expect(statusText()).toMatch(/^Vendor list loaded/);
    });
    await chooseFiles(user, csvFile('notes.csv', 'a,b\n1,2\n'));
    await waitFor(() => {
      expect(alertText()).toBe(
        'notes.csv is not an IEEE vendor list: it needs the columns “Assignment” and “Organization Name”.',
      );
    });
    expect(statusText()).toBe('');
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'oui.csv: entries read: 3',
    ]);
  });

  it('reports the other errors of a file', async () => {
    const user = await open();
    await chooseFiles(user, csvFile('a.csv', 'Registry,Assignment,Organization Name\n'));
    await waitFor(() => {
      expect(alertText()).toBe('a.csv has no usable entries.');
    });
    await chooseFiles(user, csvFile('b.csv', '"open'));
    await waitFor(() => {
      expect(alertText()).toBe('b.csv is damaged: a quotation mark is never closed.');
    });
  });

  it('counts the rows that were left out', async () => {
    const user = await open();
    await chooseFiles(
      user,
      csvFile('oui.csv', 'Assignment,Organization Name\n00A0B0,Example\nXYZ,Broken\n'),
    );
    await waitFor(() => {
      expect(screen.queryAllByRole('listitem')).toHaveLength(1);
    });
    expect(screen.getByRole('listitem').textContent).toBe(
      'oui.csv: entries read: 1, rows left out: 1',
    );
    expect(statusText()).toBe('Vendor list loaded: 1 entry. It stays in this tab.');
  });

  it('refuses a file that is too big', async () => {
    const user = await open();
    const big = csvFile('big.csv', SAMPLE_MA_L);
    Object.defineProperty(big, 'size', { value: 16 * 1024 * 1024 + 1 });
    await chooseFiles(user, big);
    await waitFor(() => {
      expect(alertText()).toBe('big.csv is larger than 16 MB.');
    });
  });

  it('refuses more files than it reads, and does not start a worker for them', async () => {
    const user = await open();
    const files = Array.from({ length: 9 }, (_, index) => csvFile(`f${String(index)}.csv`, 'x'));
    await chooseFiles(user, ...files);
    await waitFor(() => {
      expect(alertText()).toBe('Choose at most 8 files at once.');
    });
    expect(pool.created).toBe(0);
  });

  it('refuses a dropped file that is not a CSV', async () => {
    const user = userEvent.setup({ applyAccept: false });
    await openTool(manifest);
    await user.upload(filePicker(), new File(['x'], 'photo.png', { type: 'image/png' }));
    expect(alertText()).toBe('Only .csv files can be read.');
    expect(pool.created).toBe(0);
  });

  it('stops reading after the time limit', async () => {
    setBehaviour('hang');
    const user = await open();
    await chooseFiles(user, csvFile('oui.csv', SAMPLE_MA_L));
    expect(statusText()).toBe('Reading the vendor lists…');
    await waitFor(() => {
      expect(alertText()).toBe('Reading took longer than 0.3 seconds and was stopped.');
    });
    expect(statusText()).toBe('');
    expect(screen.queryByRole('button', { name: 'Remove the vendor list' })).toBeNull();
  });

  it('says so when the worker itself fails', async () => {
    setBehaviour('fail');
    const user = await open();
    await chooseFiles(user, csvFile('oui.csv', SAMPLE_MA_L));
    await waitFor(() => {
      expect(alertText()).toBe('The files could not be read.');
    });
  });

  it('stops a read that is running when the list is removed, without an error', async () => {
    const user = await open();
    await chooseFiles(user, csvFile('oui.csv', SAMPLE_MA_L));
    await waitFor(() => {
      expect(statusText()).toMatch(/^Vendor list loaded/);
    });
    setBehaviour('hang');
    await chooseFiles(user, csvFile('mam.csv', SAMPLE_MA_M));
    expect(statusText()).toBe('Reading the vendor lists…');
    expect(filePicker().disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Remove the vendor list' }));
    expect(statusText()).toBe('The vendor list was removed.');
    expect(filePicker().disabled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alertText()).toBe('');
    expect(statusText()).toBe('The vendor list was removed.');
  });

  it('terminates its worker when the tool is left', async () => {
    const user = await open();
    await chooseFiles(user, csvFile('oui.csv', SAMPLE_MA_L));
    await waitFor(() => {
      expect(statusText()).toMatch(/^Vendor list loaded/);
    });
    cleanup();
    expect(pool.terminated).toBe(1);
  });
});

describe('in German', () => {
  it('shows the German texts', async () => {
    await open();
    i18n.setLocale('de');
    await screen.findByRole('heading', { level: 1, name: 'MAC-Adresse' });
    expect(properties()['Übertragung']).toBe('Unicast');
    expect(properties()['Verwaltung']).toBe('Universell');
    expect(properties()['Hersteller']).toBe(
      'Keine Herstellerliste geladen. Wähle unten die IEEE-Listen.',
    );
    expect(
      screen.getByRole('heading', { level: 2, name: 'Herstellernamen (optional)' }),
    ).toBeDefined();
  });
});
