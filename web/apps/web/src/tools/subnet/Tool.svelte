<script lang="ts">
  import { Input, Select, Textarea, VisuallyHidden, StatusMessage } from '@mozra-the-great/kern';
  import { tick } from 'svelte';
  import { i18n, t, type MessageKey } from '../../i18n/index.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import DownloadButton from '../../app/DownloadButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import { BITS, expandV6, formatAddress, type AddressErrorCode } from './ip.ts';
  import {
    MAX_ENTRIES,
    MAX_LIST_LENGTH,
    MAX_SUBNETS,
    compareNetworks,
    describeNetwork,
    formatCidr,
    ipv4ToMapped,
    mappedToIpv4,
    parseList,
    parseNetwork,
    powerOfTwo,
    splitNetwork,
    summarise,
    type EntryErrorCode,
    type ListErrorCode,
    type Network,
    type NetworkErrorCode,
    type SplitErrorCode,
  } from './net.ts';

  type Mode = 'info' | 'split' | 'summary' | 'contains';
  type SplitBy = 'count' | 'prefix';

  interface Row {
    readonly label: string;
    readonly value: string;
    /** What the copy button puts on the clipboard; none for a row that holds no value. */
    readonly copy: string | null;
  }

  const ADDRESS_ERRORS: Readonly<Record<AddressErrorCode, MessageKey>> = {
    empty: 'subnet.error.empty',
    'too-long': 'subnet.error.tooLong',
    characters: 'subnet.error.characters',
    'ipv4-octets': 'subnet.error.ipv4Octets',
    'ipv4-range': 'subnet.error.ipv4Range',
    'ipv4-zero': 'subnet.error.ipv4Zero',
    'ipv6-zone': 'subnet.error.ipv6Zone',
    'ipv6-colons': 'subnet.error.ipv6Colons',
    'ipv6-groups': 'subnet.error.ipv6Groups',
    'ipv6-group': 'subnet.error.ipv6Group',
    'ipv6-ipv4': 'subnet.error.ipv6Ipv4',
  };

  const NETWORK_ERRORS: Readonly<Record<NetworkErrorCode, MessageKey>> = {
    ...ADDRESS_ERRORS,
    slash: 'subnet.error.slash',
    prefix: 'subnet.error.prefix',
    mask: 'subnet.error.mask',
  };

  const ENTRY_ERRORS: Readonly<Record<EntryErrorCode, MessageKey>> = {
    ...NETWORK_ERRORS,
    'range-order': 'subnet.error.rangeOrder',
    'range-version': 'subnet.error.rangeVersion',
  };

  const LIST_ERRORS: Readonly<Record<ListErrorCode, MessageKey>> = {
    empty: 'subnet.list.error.empty',
    'too-long': 'subnet.list.error.tooLong',
    'too-many': 'subnet.list.error.tooMany',
  };

  const SPLIT_ERRORS: Readonly<Record<SplitErrorCode, MessageKey>> = {
    empty: 'subnet.split.error.empty',
    number: 'subnet.split.error.number',
    power: 'subnet.split.error.power',
    range: 'subnet.split.error.range',
    'too-small': 'subnet.split.error.tooSmall',
    'too-many': 'subnet.split.error.tooMany',
  };

  let mode = $state<Mode>('info');
  let networkText = $state('192.0.2.0/24');
  let splitBy = $state<SplitBy>('count');
  let splitText = $state('4');
  let otherText = $state('192.0.2.77');
  let listText = $state('192.0.2.0/25\n192.0.2.128/25\n198.51.100.0/24');
  let status = $state('');

  const modeOptions = $derived([
    { value: 'info', label: t('subnet.mode.info') },
    { value: 'split', label: t('subnet.mode.split') },
    { value: 'summary', label: t('subnet.mode.summary') },
    { value: 'contains', label: t('subnet.mode.contains') },
  ]);
  const splitByOptions = $derived([
    { value: 'count', label: t('subnet.splitBy.count') },
    { value: 'prefix', label: t('subnet.splitBy.prefix') },
  ]);

  const network = $derived(parseNetwork(networkText));
  const networkLabel = $derived.by((): string => {
    if (mode === 'split') {
      return t('subnet.network.split');
    }
    return mode === 'contains' ? t('subnet.network.contains') : t('subnet.network.info');
  });
  const networkError = $derived(
    mode === 'summary' || network.ok ? '' : t(NETWORK_ERRORS[network.error]),
  );

  function numberFormat(value: bigint): string {
    return new Intl.NumberFormat(i18n.locale).format(value);
  }

  function show(network: Network): string {
    return formatCidr(network.version, network.address, network.prefix);
  }

  /* ---- details of one network ---- */

  const details = $derived(
    mode === 'info' && network.ok ? describeNetwork(network.network) : undefined,
  );

  const infoRows = $derived.by((): Row[] => {
    if (details === undefined || !network.ok) {
      return [];
    }
    const { version } = details;
    const text = (value: bigint): string => formatAddress({ version, value });
    const rows: Row[] = [];
    const add = (key: MessageKey, value: string, copy: string | null = value): void => {
      rows.push({ label: t(key), value, copy });
    };
    add('subnet.row.address', text(details.given));
    add('subnet.row.network', text(details.network));
    add('subnet.row.cidr', formatCidr(version, details.network, details.prefix));
    add('subnet.row.netmask', text(details.netmask));
    add('subnet.row.wildcard', text(details.wildcard));
    if (version === 4) {
      if (details.broadcast === undefined) {
        add('subnet.row.broadcast', t('subnet.none'), null);
      } else {
        add('subnet.row.broadcast', text(details.broadcast));
      }
    } else {
      add('subnet.row.lastAddress', text(details.last));
    }
    add('subnet.row.first', text(details.firstUsable));
    add('subnet.row.last', text(details.lastUsable));
    const power = powerOfTwo(details.total);
    add(
      'subnet.row.addresses',
      power === undefined
        ? numberFormat(details.total)
        : `${numberFormat(details.total)} (${power})`,
      details.total.toString(),
    );
    if (version === 4) {
      add('subnet.row.usable', numberFormat(details.usable), details.usable.toString());
      add('subnet.row.mapped', show(ipv4ToMapped(network.network)));
    } else {
      add('subnet.row.expanded', `${expandV6(details.network)}/${String(details.prefix)}`);
      const plain = mappedToIpv4(network.network);
      if (plain !== undefined) {
        add('subnet.row.ipv4', show(plain));
      }
    }
    return rows;
  });

  const infoNotes = $derived.by((): string[] => {
    if (details === undefined) {
      return [];
    }
    const notes: string[] = [];
    if (details.hostBitsSet) {
      notes.push(
        t('subnet.note.hostBits', {
          network: formatAddress({ version: details.version, value: details.network }),
        }),
      );
    }
    if (details.version === 4) {
      if (details.prefix === 31) {
        notes.push(t('subnet.note.pointToPoint4'));
      } else if (details.prefix === 32) {
        notes.push(t('subnet.note.host4'));
      }
    } else if (details.prefix === 127) {
      notes.push(t('subnet.note.pointToPoint6'));
    } else if (details.prefix === 128) {
      notes.push(t('subnet.note.host6'));
    } else {
      notes.push(t('subnet.note.noBroadcast6'));
    }
    return notes;
  });

  /* ---- split ---- */

  const split = $derived(
    mode === 'split' && network.ok
      ? splitNetwork(network.network, { by: splitBy, text: splitText })
      : undefined,
  );
  const splitError = $derived.by((): string => {
    if (split === undefined || split.ok || !network.ok) {
      return '';
    }
    return t(SPLIT_ERRORS[split.error], {
      min: network.network.prefix,
      max: split.error === 'range' ? BITS[network.network.version] : MAX_SUBNETS,
    });
  });
  const splitRows = $derived.by(() => {
    if (split?.ok !== true) {
      return [];
    }
    return split.subnets.map((subnet, index) => {
      const info = describeNetwork(subnet);
      const text = (value: bigint): string => formatAddress({ version: subnet.version, value });
      return {
        index: index + 1,
        cidr: show(subnet),
        first: text(info.firstUsable),
        last: text(info.lastUsable),
      };
    });
  });
  const splitList = $derived(splitRows.map((row) => row.cidr).join('\n'));

  /* ---- summary ---- */

  const list = $derived(mode === 'summary' ? parseList(listText) : undefined);
  const summaries = $derived(
    list?.ok === true
      ? summarise(list.ranges).map((summary) => ({
          version: summary.version,
          name: t(summary.version === 4 ? 'subnet.sum.ipv4' : 'subnet.sum.ipv6'),
          entries: summary.entries,
          networks: summary.networks.map(show),
          addresses: summary.addresses,
          supernet: show(summary.supernet),
        }))
      : [],
  );
  const networkCount = $derived(
    summaries.reduce((sum, summary) => sum + summary.networks.length, 0),
  );
  const listError = $derived.by((): string => {
    if (list === undefined || list.ok) {
      return '';
    }
    if ('line' in list) {
      return t('subnet.list.error.line', {
        line: list.line,
        problem: t(ENTRY_ERRORS[list.error]),
      });
    }
    return t(LIST_ERRORS[list.error], {
      max: list.error === 'too-long' ? MAX_LIST_LENGTH : MAX_ENTRIES,
    });
  });

  /* ---- contains ---- */

  const other = $derived(parseNetwork(otherText));
  const otherError = $derived(
    mode === 'contains' && !other.ok ? t(NETWORK_ERRORS[other.error]) : '',
  );
  const verdict = $derived.by((): string => {
    if (mode !== 'contains' || !network.ok || !other.ok) {
      return '';
    }
    const { relation, converted } = compareNetworks(network.network, other.network);
    const params = {
      network: show(network.network),
      address: formatAddress({ version: other.network.version, value: other.network.address }),
      other: show(other.network),
    };
    let sentence: string;
    if (!other.hadPrefix) {
      sentence =
        relation === 'same' || relation === 'inside'
          ? t('subnet.contains.in', params)
          : t('subnet.contains.out', params);
    } else if (relation === 'same') {
      sentence = t('subnet.contains.same', params);
    } else if (relation === 'inside') {
      sentence = t('subnet.contains.inside', params);
    } else if (relation === 'contains') {
      sentence = t('subnet.contains.around', params);
    } else {
      sentence = t('subnet.contains.apart', params);
    }
    return converted ? `${sentence} ${t('subnet.contains.mapped')}` : sentence;
  });

  /* ---- what is said ---- */

  const message = $derived.by((): string => {
    if (mode === 'summary') {
      return list?.ok === true ? t('subnet.announce.summary', { count: networkCount }) : listError;
    }
    if (!network.ok) {
      return networkError;
    }
    if (mode === 'info' && details !== undefined) {
      return t('subnet.announce.info', {
        network: formatCidr(details.version, details.network, details.prefix),
        first: formatAddress({ version: details.version, value: details.firstUsable }),
        last: formatAddress({ version: details.version, value: details.lastUsable }),
        usable: numberFormat(details.usable),
      });
    }
    if (mode === 'split') {
      return split?.ok === true
        ? t('subnet.split.count', { count: split.count, prefix: split.prefix })
        : splitError;
    }
    return other.ok ? verdict : otherError;
  });

  /** Says the result once the new value is in (a change event can arrive before the binding updates). */
  async function announce(): Promise<void> {
    await tick();
    status = message;
  }

  function changed(): void {
    void announce();
  }

  function onSplitBy(): void {
    if (splitBy === 'count') {
      splitText = '4';
    } else {
      splitText = network.ok
        ? String(Math.min(BITS[network.network.version], network.network.prefix + 2))
        : '';
    }
    void announce();
  }

  function onMode(): void {
    status = '';
    void announce();
  }
</script>

<ToolFrame id="subnet">
  <div class="tool">
    <section class="block">
      <Select label={t('subnet.mode')} options={modeOptions} bind:value={mode} onchange={onMode} />
      {#if mode === 'summary'}
        <Textarea
          keepHint
          label={t('subnet.list')}
          hint={t('subnet.listHint')}
          bind:value={listText}
          error={listError}
          announce={false}
          rows={7}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          onchange={changed}
        />
      {:else}
        <Input
          keepHint
          label={networkLabel}
          hint={t('subnet.networkHint')}
          bind:value={networkText}
          error={networkError}
          announce={false}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          onchange={changed}
        />
      {/if}
      {#if mode === 'split'}
        <div class="grid">
          <Select
            label={t('subnet.splitBy')}
            options={splitByOptions}
            bind:value={splitBy}
            onchange={onSplitBy}
          />
          <Input
            keepHint
            label={splitBy === 'count'
              ? t('subnet.splitValue.count')
              : t('subnet.splitValue.prefix')}
            hint={t(splitBy === 'count' ? 'subnet.splitHint.count' : 'subnet.splitHint.prefix', {
              max: MAX_SUBNETS,
            })}
            bind:value={splitText}
            error={splitError}
            announce={false}
            inputmode="numeric"
            autocomplete="off"
            spellcheck={false}
            onchange={changed}
          />
        </div>
      {:else if mode === 'contains'}
        <Input
          keepHint
          label={t('subnet.other')}
          hint={t('subnet.otherHint')}
          bind:value={otherText}
          error={otherError}
          announce={false}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          onchange={changed}
        />
      {/if}
      <StatusMessage data-tool-status tone="ok" message={status} />
    </section>

    {#if details !== undefined}
      <section class="block">
        <h2 class="heading">{t('subnet.results')}</h2>
        <table aria-label={t('subnet.info.caption')}>
          <thead>
            <tr>
              <th scope="col">{t('subnet.col.property')}</th>
              <th scope="col">{t('subnet.col.value')}</th>
              <th scope="col"><VisuallyHidden>{t('subnet.col.copy')}</VisuallyHidden></th>
            </tr>
          </thead>
          <tbody>
            {#each infoRows as row (row.label)}
              <tr>
                <th scope="row">{row.label}</th>
                <td class="code">{row.value}</td>
                <td>
                  {#if row.copy !== null}
                    <CopyButton
                      text={row.copy}
                      label={t('subnet.copyRow', { name: row.label })}
                      value={row.copy}
                    />
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#each infoNotes as note (note)}
          <p class="note">{note}</p>
        {/each}
      </section>
    {:else if split?.ok === true}
      <section class="block">
        <h2 class="heading">{t('subnet.results')}</h2>
        <p class="lead">{t('subnet.split.count', { count: split.count, prefix: split.prefix })}</p>
        <table aria-label={t('subnet.split.caption')}>
          <thead>
            <tr>
              <th scope="col">{t('subnet.col.index')}</th>
              <th scope="col">{t('subnet.col.subnet')}</th>
              <th scope="col">{t('subnet.col.first')}</th>
              <th scope="col">{t('subnet.col.last')}</th>
            </tr>
          </thead>
          <tbody>
            {#each splitRows as row (row.index)}
              <tr>
                <td>{row.index}</td>
                <td class="code">{row.cidr}</td>
                <td class="code">{row.first}</td>
                <td class="code">{row.last}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div class="actions">
          <CopyButton
            text={splitList}
            label={t('subnet.split.copy')}
            value={t('subnet.split.copiedValue')}
          />
          <DownloadButton
            label={t('subnet.split.download')}
            name="subnets.txt"
            text={`${splitList}\n`}
          />
        </div>
      </section>
    {:else if list?.ok === true}
      <section class="block">
        <h2 class="heading">{t('subnet.results')}</h2>
        {#each summaries as summary (summary.version)}
          <h3 class="subheading">{summary.name}</h3>
          <table aria-label={t('subnet.sum.caption', { version: summary.name })}>
            <thead>
              <tr>
                <th scope="col">{t('subnet.col.property')}</th>
                <th scope="col">{t('subnet.col.value')}</th>
                <th scope="col"><VisuallyHidden>{t('subnet.col.copy')}</VisuallyHidden></th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">{t('subnet.sum.entries')}</th>
                <td class="code">{numberFormat(BigInt(summary.entries))}</td>
                <td></td>
              </tr>
              <tr>
                <th scope="row">{t('subnet.sum.networks')}</th>
                <td class="code">{numberFormat(BigInt(summary.networks.length))}</td>
                <td></td>
              </tr>
              <tr>
                <th scope="row">{t('subnet.sum.addresses')}</th>
                <td class="code">{numberFormat(summary.addresses)}</td>
                <td>
                  <CopyButton
                    text={summary.addresses.toString()}
                    label={t('subnet.copyRow', { name: t('subnet.sum.addresses') })}
                    value={summary.addresses.toString()}
                  />
                </td>
              </tr>
              <tr>
                <th scope="row">{t('subnet.sum.supernet')}</th>
                <td class="code">{summary.supernet}</td>
                <td>
                  <CopyButton
                    text={summary.supernet}
                    label={t('subnet.copyRow', { name: t('subnet.sum.supernet') })}
                    value={summary.supernet}
                  />
                </td>
              </tr>
            </tbody>
          </table>
          <ul class="networks" aria-label={t('subnet.sum.list', { version: summary.name })}>
            {#each summary.networks as cidr, index (index)}
              <li class="code">{cidr}</li>
            {/each}
          </ul>
          <div class="actions">
            <CopyButton
              text={summary.networks.join('\n')}
              label={t('subnet.sum.copy', { version: summary.name })}
              value={t('subnet.sum.copiedValue', { version: summary.name })}
            />
            <DownloadButton
              label={t('subnet.sum.download', { version: summary.name })}
              name={`networks-ipv${String(summary.version)}.txt`}
              text={`${summary.networks.join('\n')}\n`}
            />
          </div>
        {/each}
      </section>
    {:else if verdict !== ''}
      <section class="block">
        <h2 class="heading">{t('subnet.results')}</h2>
        <p class="lead">{verdict}</p>
      </section>
    {/if}
  </div>
</ToolFrame>

<style>
  .tool {
    display: flex;
    flex-direction: column;
    gap: var(--k-space-8);
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: var(--k-space-4);
    max-width: 760px;
  }

  .heading {
    margin: 0;
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.4px;
  }

  .subheading {
    margin: var(--k-space-2) 0 0;
    font-size: 16px;
    font-weight: 500;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--k-space-5);
  }

  .lead {
    margin: 0;
    font: 500 18px/1.5 var(--k-font-mono);
    overflow-wrap: anywhere;
  }

  .note {
    margin: 0;
    font: 13px var(--k-font-mono);
    color: var(--k-fg-muted);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--k-space-3);
  }

  table {
    border-collapse: collapse;
    width: 100%;
    font: 14px var(--k-font-mono);
  }

  th,
  td {
    padding: var(--k-space-2) var(--k-space-3);
    border-bottom: 1px solid var(--k-line);
    text-align: left;
    font-weight: 400;
    vertical-align: middle;
    overflow-wrap: anywhere;
  }

  thead th,
  tbody th {
    color: var(--k-fg-muted);
  }

  .networks {
    display: flex;
    flex-direction: column;
    gap: var(--k-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
    font: 14px var(--k-font-mono);
  }
</style>
