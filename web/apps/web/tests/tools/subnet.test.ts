import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/subnet/manifest.ts';
import { toast } from '@mozra-the-great/kern';
import { openTool } from '../tool-helpers.ts';
import { defined } from './defined.ts';

type User = ReturnType<typeof userEvent.setup>;
type Mode = 'info' | 'split' | 'summary' | 'contains';

const download = vi.hoisted(() => ({ saveText: vi.fn() }));
vi.mock('../../src/app/download.ts', () => download);

beforeEach(() => {
  download.saveText.mockReset();
});

afterEach(() => {
  toast.clear();
  i18n.setLocale('en');
  vi.restoreAllMocks();
});

const MODE_LABELS: Readonly<Record<Mode, string>> = {
  info: 'Network details',
  split: 'Split into subnets',
  summary: 'Summarise networks and ranges',
  contains: 'Is it inside?',
};

async function open(mode: Mode = 'info'): Promise<User> {
  const user = userEvent.setup();
  await openTool(manifest);
  if (mode !== 'info') {
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'What to calculate' }),
      MODE_LABELS[mode],
    );
  }
  return user;
}

function field(name: string): HTMLInputElement | HTMLTextAreaElement {
  return screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name });
}

/** Replaces the text of a field and leaves it, which is when the result is announced. */
async function enter(user: User, name: string, text: string): Promise<void> {
  const box = field(name);
  await user.clear(box);
  await user.click(box);
  if (text !== '') {
    await user.paste(text);
  }
  await user.tab();
}

function statusText(): string {
  return [...document.querySelectorAll('main .tool-status')]
    .map((region) => region.textContent.trim())
    .filter((text) => text !== '')
    .join('|');
}

/** The rows of the first table with a row header: the label and the value of each. */
function properties(): Record<string, string> {
  const table = screen.queryByRole('table');
  if (table === null) {
    return {};
  }
  return Object.fromEntries(
    within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => [
        within(row).getByRole('rowheader').textContent,
        within(row).getAllByRole('cell')[0]?.textContent ?? '',
      ]),
  );
}

function fieldError(name: string): string {
  const box = field(name);
  if (box.getAttribute('aria-invalid') !== 'true') {
    return '';
  }
  const ids = (box.getAttribute('aria-describedby') ?? '').split(' ');
  return ids
    .filter((id) => id.endsWith('-error'))
    .map((id) => document.getElementById(id)?.textContent.trim() ?? '')
    .join(' ');
}

const INFO = 'IP address or network';

describe('subnet', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
    expect(manifest.category).toBe('network');
  });

  it('opens at /tools/subnet with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/subnet');
    expect(view.headings).toEqual(['Subnet calculator']);
    expect(view.searchHits('cidr')).toEqual(['subnet']);
    expect(view.searchHits('netzmaske')).toEqual(['subnet']);
  });
});

describe('network details', () => {
  it('shows the details of 192.0.2.0/24 when it opens', async () => {
    await open();
    expect(properties()).toEqual({
      Address: '192.0.2.0',
      'Network address': '192.0.2.0',
      'Network (CIDR)': '192.0.2.0/24',
      Netmask: '255.255.255.0',
      'Wildcard mask': '0.0.0.255',
      'Broadcast address': '192.0.2.255',
      'First usable address': '192.0.2.1',
      'Last usable address': '192.0.2.254',
      Addresses: '256 (2^8)',
      'Usable addresses': '254',
      'IPv4-mapped IPv6 form': '::ffff:192.0.2.0/120',
    });
    expect(screen.getByRole('heading', { level: 2, name: 'Result' })).toBeDefined();
  });

  it('reads an address with host bits, a mask and no prefix, and says so', async () => {
    const user = await open();
    await enter(user, INFO, '198.51.100.77/255.255.255.192');
    expect(properties()['Network (CIDR)']).toBe('198.51.100.64/26');
    expect(properties()['Address']).toBe('198.51.100.77');
    expect(
      screen.getByText('The address has host bits set. The network starts at 198.51.100.64.'),
    ).toBeDefined();
    expect(statusText()).toBe('198.51.100.64/26: 198.51.100.65 to 198.51.100.126, 62 usable.');
  });

  it('describes /0 with its big numbers', async () => {
    const user = await open();
    await enter(user, INFO, '0.0.0.0/0');
    expect(properties()).toMatchObject({
      Addresses: '4,294,967,296 (2^32)',
      'Usable addresses': '4,294,967,294',
      'Broadcast address': '255.255.255.255',
      Netmask: '0.0.0.0',
      'Wildcard mask': '255.255.255.255',
    });
  });

  it('describes /31 without a broadcast address, and /32 as one host', async () => {
    const user = await open();
    await enter(user, INFO, '192.0.2.2/31');
    expect(properties()).toMatchObject({
      'Broadcast address': 'none',
      'First usable address': '192.0.2.2',
      'Last usable address': '192.0.2.3',
      'Usable addresses': '2',
      Addresses: '2 (2^1)',
    });
    expect(screen.getByText(/point-to-point link \(RFC 3021\)/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Copy Broadcast address' })).toBeNull();
    await enter(user, INFO, '192.0.2.9');
    expect(properties()).toMatchObject({
      'Network (CIDR)': '192.0.2.9/32',
      'First usable address': '192.0.2.9',
      'Last usable address': '192.0.2.9',
      Addresses: '1',
      Netmask: '255.255.255.255',
    });
    expect(screen.getByText('A /32 is a single host.')).toBeDefined();
  });

  it('describes an IPv6 network, with the expanded form and no broadcast address', async () => {
    const user = await open();
    await enter(user, INFO, '2001:db8:1:2:3:4:5:6/64');
    expect(properties()).toEqual({
      Address: '2001:db8:1:2:3:4:5:6',
      'Network address': '2001:db8:1:2::',
      'Network (CIDR)': '2001:db8:1:2::/64',
      Netmask: 'ffff:ffff:ffff:ffff::',
      'Wildcard mask': '::ffff:ffff:ffff:ffff',
      'Last address': '2001:db8:1:2:ffff:ffff:ffff:ffff',
      'First usable address': '2001:db8:1:2::',
      'Last usable address': '2001:db8:1:2:ffff:ffff:ffff:ffff',
      Addresses: '18,446,744,073,709,551,616 (2^64)',
      'Expanded form': '2001:0db8:0001:0002:0000:0000:0000:0000/64',
    });
    expect(screen.getByText(/IPv6 has no broadcast address/)).toBeDefined();
    expect(screen.getByText(/host bits set/)).toBeDefined();
  });

  it('describes /0, /127 and /128 of IPv6', async () => {
    const user = await open();
    await enter(user, INFO, '::/0');
    expect(properties()['Addresses']).toBe(
      '340,282,366,920,938,463,463,374,607,431,768,211,456 (2^128)',
    );
    await enter(user, INFO, '2001:db8::2/127');
    expect(properties()).toMatchObject({
      'First usable address': '2001:db8::2',
      'Last usable address': '2001:db8::3',
      Addresses: '2 (2^1)',
    });
    expect(screen.getByText(/point-to-point link \(RFC 6164\)/)).toBeDefined();
    await enter(user, INFO, '2001:db8::1/128');
    expect(properties()['Addresses']).toBe('1');
    expect(screen.getByText('A /128 is a single address.')).toBeDefined();
  });

  it('shows the IPv4 form of an IPv4-mapped network', async () => {
    const user = await open();
    await enter(user, INFO, '::ffff:192.0.2.0/120');
    expect(properties()).toMatchObject({
      'Network (CIDR)': '::ffff:192.0.2.0/120',
      'IPv4 form': '192.0.2.0/24',
    });
    await enter(user, INFO, '2001:db8::/32');
    expect(properties()['IPv4 form']).toBeUndefined();
  });

  it('says what is wrong, in the field and in the status', async () => {
    const user = await open();
    await enter(user, INFO, '192.0.2.256/24');
    expect(fieldError(INFO)).toBe('Each number of an IPv4 address is from 0 to 255.');
    expect(screen.queryByRole('table')).toBeNull();
    expect(statusText()).toBe('Each number of an IPv4 address is from 0 to 255.');
    await enter(user, INFO, '192.0.2.0/33');
    expect(fieldError(INFO)).toMatch(/prefix length is a whole number/);
    await enter(user, INFO, '192.0.2.0/255.0.255.0');
    expect(fieldError(INFO)).toMatch(/not a netmask/);
    await enter(user, INFO, '');
    expect(fieldError(INFO)).toBe('Enter an IP address or a network.');
    await enter(user, INFO, '10.0.0.0/8');
    expect(fieldError(INFO)).toBe('');
    expect(properties()['Network (CIDR)']).toBe('10.0.0.0/8');
  });

  it('copies a value and confirms it', async () => {
    const user = await open();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await user.click(screen.getByRole('button', { name: 'Copy Netmask' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('255.255.255.0');
    });
    await user.click(screen.getByRole('button', { name: 'Copy Addresses' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenLastCalledWith('256');
    });
  });
});

describe('split', () => {
  const NETWORK = 'Network to split';

  function subnetRows(): string[][] {
    return screen
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      );
  }

  it('splits 192.0.2.0/24 into four subnets when it is chosen', async () => {
    await open('split');
    expect(subnetRows()).toEqual([
      ['1', '192.0.2.0/26', '192.0.2.1', '192.0.2.62'],
      ['2', '192.0.2.64/26', '192.0.2.65', '192.0.2.126'],
      ['3', '192.0.2.128/26', '192.0.2.129', '192.0.2.190'],
      ['4', '192.0.2.192/26', '192.0.2.193', '192.0.2.254'],
    ]);
    expect(document.querySelector('main .lead')?.textContent).toBe(
      '4 subnets with prefix length /26.',
    );
  });

  it('announces the result when the number changes', async () => {
    const user = await open('split');
    await enter(user, 'Number of subnets', '1');
    expect(statusText()).toBe('1 subnet with prefix length /24.');
    expect(subnetRows()).toHaveLength(1);
    await enter(user, 'Number of subnets', '2');
    expect(statusText()).toBe('2 subnets with prefix length /25.');
  });

  it('splits by prefix length, and picks a sensible one when the way is changed', async () => {
    const user = await open('split');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Split by' }),
      'Prefix length of each subnet',
    );
    expect(field('New prefix length').value).toBe('26');
    await enter(user, 'New prefix length', '25');
    expect(subnetRows().map((row) => row[1])).toEqual(['192.0.2.0/25', '192.0.2.128/25']);
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Split by' }),
      'Number of subnets',
    );
    expect(field('Number of subnets').value).toBe('4');
  });

  it('splits IPv6, and lists a /32 at the longest prefix as one network', async () => {
    const user = await open('split');
    await enter(user, NETWORK, '2001:db8::/62');
    await enter(user, 'Number of subnets', '4');
    expect(subnetRows().map((row) => row[1])).toEqual([
      '2001:db8::/64',
      '2001:db8:0:1::/64',
      '2001:db8:0:2::/64',
      '2001:db8:0:3::/64',
    ]);
    await enter(user, NETWORK, '192.0.2.5/32');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Split by' }),
      'Prefix length of each subnet',
    );
    expect(field('New prefix length').value).toBe('32');
    expect(subnetRows()).toEqual([['1', '192.0.2.5/32', '192.0.2.5', '192.0.2.5']]);
  });

  it('says what is wrong with the network and with the number', async () => {
    const user = await open('split');
    await enter(user, NETWORK, 'nonsense');
    expect(fieldError(NETWORK)).toMatch(/four numbers separated by dots/);
    expect(screen.queryByRole('table')).toBeNull();
    expect(statusText()).toMatch(/four numbers/);
    await enter(user, NETWORK, '192.0.2.0/24');
    await enter(user, 'Number of subnets', '3');
    expect(fieldError('Number of subnets')).toBe(
      'The number of subnets must be a power of two (1, 2, 4, 8 …).',
    );
    expect(screen.queryByRole('table')).toBeNull();
    await enter(user, 'Number of subnets', '512');
    expect(fieldError('Number of subnets')).toBe(
      'This network is too small to be split into that many subnets.',
    );
    await enter(user, 'Number of subnets', 'x');
    expect(fieldError('Number of subnets')).toMatch(/whole number/);
    await enter(user, 'Number of subnets', '');
    expect(fieldError('Number of subnets')).toBe('Enter a value.');
    await enter(user, NETWORK, '10.0.0.0/8');
    await enter(user, 'Number of subnets', '8192');
    expect(fieldError('Number of subnets')).toBe(
      'That makes more than 4,096 subnets. Choose fewer subnets or a longer prefix.',
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Split by' }),
      'Prefix length of each subnet',
    );
    await enter(user, 'New prefix length', '7');
    expect(fieldError('New prefix length')).toBe('The prefix length must be from 8 to 32.');
  });

  it('keeps the prefix field empty when the network is wrong', async () => {
    const user = await open('split');
    await enter(user, NETWORK, 'nonsense');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Split by' }),
      'Prefix length of each subnet',
    );
    expect(field('New prefix length').value).toBe('');
  });

  it('copies the list and offers it as a download', async () => {
    const user = await open('split');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await user.click(screen.getByRole('button', { name: 'Copy list of subnets' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        '192.0.2.0/26\n192.0.2.64/26\n192.0.2.128/26\n192.0.2.192/26',
      );
    });
    await user.click(screen.getByRole('button', { name: 'Download as .txt' }));
    expect(download.saveText).toHaveBeenCalledWith(
      'subnets.txt',
      '192.0.2.0/26\n192.0.2.64/26\n192.0.2.128/26\n192.0.2.192/26\n',
    );
  });
});

describe('summarise', () => {
  const LIST = 'Networks, addresses and ranges';

  function networks(): string[] {
    return screen.getAllByRole('listitem').map((item) => item.textContent);
  }

  it('joins the neighbours of the example into one network and keeps the other', async () => {
    await open('summary');
    expect(networks()).toEqual(['192.0.2.0/24', '198.51.100.0/24']);
    expect(properties()).toEqual({
      'Entries read': '3',
      'Networks needed': '2',
      'Addresses covered': '512',
      'Smallest single network that holds everything': '192.0.0.0/5',
    });
  });

  it('reads ranges, comments, commas and several IP versions', async () => {
    const user = await open('summary');
    await enter(
      user,
      LIST,
      '198.51.100.1-198.51.100.6 # a range\n198.51.100.0; 198.51.100.7\n2001:db8::/33, 2001:db8:8000::/33\n',
    );
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(['IPv4', 'IPv6']);
    expect(networks()).toEqual(['198.51.100.0/29', '2001:db8::/32']);
    expect(statusText()).toBe('Summarised to 2 networks.');
    const tables = screen.getAllByRole('table');
    expect(tables).toHaveLength(2);
    expect(within(defined(tables[1])).getByText('2001:db8::/32', { selector: 'td' })).toBeDefined();
  });

  it('announces a single network', async () => {
    const user = await open('summary');
    await enter(user, LIST, '192.0.2.0/25\n192.0.2.128/25');
    expect(statusText()).toBe('Summarised to 1 network.');
  });

  it('names the line of the first wrong entry', async () => {
    const user = await open('summary');
    await enter(user, LIST, '192.0.2.0/24\n\n192.0.2.300');
    expect(fieldError(LIST)).toBe('Line 3: Each number of an IPv4 address is from 0 to 255.');
    expect(statusText()).toBe('Line 3: Each number of an IPv4 address is from 0 to 255.');
    expect(screen.queryByRole('table')).toBeNull();
    await enter(user, LIST, '192.0.2.9-192.0.2.1');
    expect(fieldError(LIST)).toBe('Line 1: The start of a range must not be after its end.');
    await enter(user, LIST, '192.0.2.1-2001:db8::1');
    expect(fieldError(LIST)).toMatch(/same kind/);
  });

  it('says when the list is empty or too big', async () => {
    const user = await open('summary');
    await enter(user, LIST, '');
    expect(fieldError(LIST)).toBe('Enter at least one network, address or range.');
    await enter(user, LIST, '# nothing');
    expect(fieldError(LIST)).toBe('Enter at least one network, address or range.');
    const many = Array.from({ length: 5001 }, () => '192.0.2.1').join('\n');
    const box = field(LIST);
    await user.clear(box);
    await user.click(box);
    await user.paste(many);
    await user.tab();
    expect(fieldError(LIST)).toBe('The list has more than 5,000 entries.');
    await user.clear(box);
    await user.click(box);
    await user.paste(' '.repeat(200_001));
    await user.tab();
    expect(fieldError(LIST)).toBe('The list is longer than 200,000 characters.');
  });

  it('copies the networks and offers them as a download', async () => {
    const user = await open('summary');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await user.click(screen.getByRole('button', { name: 'Copy IPv4 networks' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('192.0.2.0/24\n198.51.100.0/24');
    });
    await user.click(screen.getByRole('button', { name: 'Download IPv4 networks as .txt' }));
    expect(download.saveText).toHaveBeenCalledWith(
      'networks-ipv4.txt',
      '192.0.2.0/24\n198.51.100.0/24\n',
    );
    await user.click(screen.getByRole('button', { name: 'Copy Addresses covered' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenLastCalledWith('512');
    });
    await user.click(
      screen.getByRole('button', { name: 'Copy Smallest single network that holds everything' }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenLastCalledWith('192.0.0.0/5');
    });
  }, 20_000);
});

describe('is it inside?', () => {
  const NETWORK = 'Network';
  const OTHER = 'Address or network to check';

  function verdict(): string {
    return document.querySelector('main .lead')?.textContent ?? '';
  }

  it('checks an address against a network when it is chosen', async () => {
    await open('contains');
    expect(verdict()).toBe('192.0.2.77 is inside 192.0.2.0/24.');
  });

  it('finds an address that is outside, and announces it', async () => {
    const user = await open('contains');
    await enter(user, OTHER, '192.0.3.1');
    expect(verdict()).toBe('192.0.3.1 is not inside 192.0.2.0/24.');
    expect(statusText()).toBe('192.0.3.1 is not inside 192.0.2.0/24.');
  });

  it('compares two networks', async () => {
    const user = await open('contains');
    await enter(user, OTHER, '192.0.2.128/25');
    expect(verdict()).toBe('192.0.2.128/25 is inside 192.0.2.0/24.');
    await enter(user, OTHER, '192.0.0.0/16');
    expect(verdict()).toBe('192.0.0.0/16 contains 192.0.2.0/24.');
    await enter(user, OTHER, '192.0.2.99/24');
    expect(verdict()).toBe('192.0.2.0/24 is the same network as 192.0.2.0/24.');
    await enter(user, OTHER, '198.51.100.0/24');
    expect(verdict()).toBe('198.51.100.0/24 and 192.0.2.0/24 do not overlap.');
  });

  it('treats an address that is the whole /32 as inside', async () => {
    const user = await open('contains');
    await enter(user, NETWORK, '192.0.2.5/32');
    await enter(user, OTHER, '192.0.2.5');
    expect(verdict()).toBe('192.0.2.5 is inside 192.0.2.5/32.');
  });

  it('works for IPv6', async () => {
    const user = await open('contains');
    await enter(user, NETWORK, '2001:db8::/32');
    await enter(user, OTHER, '2001:db8:abcd::1');
    expect(verdict()).toBe('2001:db8:abcd::1 is inside 2001:db8::/32.');
    await enter(user, OTHER, '2001:db9::1');
    expect(verdict()).toBe('2001:db9::1 is not inside 2001:db8::/32.');
  });

  it('compares an IPv4-mapped address with an IPv4 network, and says how', async () => {
    const user = await open('contains');
    await enter(user, OTHER, '::ffff:192.0.2.77');
    expect(verdict()).toBe(
      '::ffff:192.0.2.77 is inside 192.0.2.0/24. One side is IPv4 and the other IPv6, so the IPv4 side was compared in its IPv4-mapped form (::ffff:a.b.c.d).',
    );
    await enter(user, OTHER, '2001:db8::1');
    expect(verdict()).toMatch(/^2001:db8::1 is not inside 192.0.2.0\/24\./);
  });

  it('says what is wrong with either field', async () => {
    const user = await open('contains');
    await enter(user, OTHER, 'x');
    expect(fieldError(OTHER)).toMatch(/four numbers/);
    expect(document.querySelector('main .lead')).toBeNull();
    expect(statusText()).toMatch(/four numbers/);
    await enter(user, OTHER, '192.0.2.1');
    await enter(user, NETWORK, '192.0.2.0/40');
    expect(fieldError(NETWORK)).toMatch(/prefix length/);
    expect(document.querySelector('main .lead')).toBeNull();
  });
});

describe('the modes', () => {
  it('keeps the network when the mode changes, and clears the old status', async () => {
    const user = await open();
    await enter(user, INFO, '10.1.2.0/23');
    expect(statusText()).not.toBe('');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'What to calculate' }),
      'Split into subnets',
    );
    expect(field('Network to split').value).toBe('10.1.2.0/23');
    await waitFor(() => {
      expect(statusText()).toBe('4 subnets with prefix length /25.');
    });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'What to calculate' }),
      'Network details',
    );
    await waitFor(() => {
      expect(statusText()).toBe('10.1.2.0/23: 10.1.2.1 to 10.1.3.254, 510 usable.');
    });
  });
});

describe('in German', () => {
  it('shows the German texts, numbers and errors', async () => {
    const user = await open();
    i18n.setLocale('de');
    await screen.findByRole('heading', { level: 1, name: 'Subnetz-Rechner' });
    expect(properties()['Adressen']).toBe('256 (2^8)');
    await enter(user, 'IP-Adresse oder Netz', '0.0.0.0/0');
    expect(properties()['Adressen']).toBe('4.294.967.296 (2^32)');
    await enter(user, 'IP-Adresse oder Netz', '1.2.3');
    expect(fieldError('IP-Adresse oder Netz')).toBe(
      'Eine IPv4-Adresse besteht aus vier Zahlen, durch Punkte getrennt, wie 192.0.2.1.',
    );
    expect(statusText()).toMatch(/^Eine IPv4-Adresse/);
  });
});
