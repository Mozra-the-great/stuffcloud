<script lang="ts">
  import { Button, FileDrop, Textarea } from '@mozra-the-great/kern';
  import type { WorkerPool } from '@stuffcloud/tools';
  import { tick } from 'svelte';
  import { t, type MessageKey } from '../../i18n/index.ts';
  import {
    IEEE_REGISTRATION_AUTHORITY_TEXT,
    IEEE_REGISTRATION_AUTHORITY_URL,
  } from '../../app/external-links.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import ToolStatus from '../../app/ToolStatus.svelte';
  import {
    MAX_ADDRESSES,
    MAX_INPUT_LENGTH,
    describeMac,
    formatMac,
    linkLocalAddress,
    parseMacList,
    type Mac,
    type MacErrorCode,
    type MacNote,
  } from './mac.ts';
  import { MAX_FILE_BYTES, MAX_FILES, OuiIndex, type OuiErrorCode } from './oui.ts';
  import { createPool } from './pool.ts';
  import {
    LOAD_TIMEOUT_MS,
    type FileSummary,
    type Input as TaskInput,
    type Output as TaskOutput,
  } from './task.ts';

  type Transmission = 'unicast' | 'multicast' | 'broadcast';

  interface Row {
    readonly label: string;
    readonly value: string;
    readonly copy: boolean;
  }

  const ERROR_KEYS: Readonly<Record<MacErrorCode, MessageKey>> = {
    empty: 'mac.error.empty',
    'too-long': 'mac.error.tooLong',
    characters: 'mac.error.characters',
    separators: 'mac.error.separators',
    group: 'mac.error.group',
    length: 'mac.error.length',
  };

  const TYPE_KEYS: Readonly<Record<Transmission, MessageKey>> = {
    unicast: 'mac.type.unicast',
    multicast: 'mac.type.multicast',
    broadcast: 'mac.type.broadcast',
  };

  const TYPE_DETAIL_KEYS: Readonly<Record<Transmission, MessageKey>> = {
    unicast: 'mac.type.unicast.detail',
    multicast: 'mac.type.multicast.detail',
    broadcast: 'mac.type.broadcast.detail',
  };

  const NOTE_KEYS: Readonly<Record<MacNote, MessageKey | undefined>> = {
    broadcast: undefined,
    'ipv4-multicast': 'mac.note.ipv4Multicast',
    'ipv6-multicast': 'mac.note.ipv6Multicast',
  };

  const LOAD_ERROR_KEYS: Readonly<Record<OuiErrorCode | 'too-large', MessageKey>> = {
    columns: 'mac.vendor.error.columns',
    empty: 'mac.vendor.error.empty',
    unterminated: 'mac.vendor.error.unterminated',
    'too-large': 'mac.vendor.error.tooLarge',
  };

  let text = $state('00:00:5e:00:53:01');
  // Not made reactive inside: the index is replaced as a whole.
  let index = $state.raw<OuiIndex | undefined>(undefined);
  let loaded = $state.raw<readonly FileSummary[]>([]);
  let loading = $state(false);
  let status = $state('');
  let failure = $state('');

  let pool: WorkerPool<TaskInput, TaskOutput> | undefined;
  let controller: AbortController | undefined;

  $effect(() => () => {
    controller?.abort();
    pool?.terminate();
  });

  const parsed = $derived(parseMacList(text));
  const lines = $derived(parsed.ok ? parsed.lines : []);
  const single = $derived(lines.length === 1 ? lines[0] : undefined);
  const singleMac = $derived(single !== undefined && 'mac' in single ? single.mac : undefined);

  const fieldError = $derived.by((): string => {
    if (!parsed.ok) {
      return parsed.error === 'too-long'
        ? t('mac.list.tooLong', { max: MAX_INPUT_LENGTH })
        : t('mac.list.tooMany', { max: MAX_ADDRESSES });
    }
    return single !== undefined && 'error' in single ? t(ERROR_KEYS[single.error]) : '';
  });

  function transmission(mac: Mac): Transmission {
    const bits = describeMac(mac);
    if (bits.note === 'broadcast') {
      return 'broadcast';
    }
    return bits.multicast ? 'multicast' : 'unicast';
  }

  function administration(mac: Mac): string {
    return t(describeMac(mac).local ? 'mac.admin.local' : 'mac.admin.universal');
  }

  function vendor(mac: Mac): string {
    if (describeMac(mac).local) {
      return t('mac.vendor.local');
    }
    const found = index?.lookup(mac);
    return found === undefined
      ? t('mac.vendor.notFound')
      : t('mac.vendor.found', { name: found.name, registry: found.registry, prefix: found.prefix });
  }

  const detailRows = $derived.by((): Row[] => {
    if (singleMac === undefined) {
      return [];
    }
    const bits = describeMac(singleMac);
    const rows: Row[] = [];
    const add = (key: MessageKey, value: string, copy = true): void => {
      rows.push({ label: t(key), value, copy });
    };
    add('mac.row.kind', bits.kind, false);
    add('mac.row.colon', formatMac(singleMac, 'colon-lower'));
    add('mac.row.colonUpper', formatMac(singleMac, 'colon-upper'));
    add('mac.row.dash', formatMac(singleMac, 'dash-upper'));
    add('mac.row.dot', formatMac(singleMac, 'dot-lower'));
    add('mac.row.bare', formatMac(singleMac, 'bare-lower'));
    add('mac.row.bareUpper', formatMac(singleMac, 'bare-upper'));
    add('mac.row.transmission', t(TYPE_KEYS[transmission(singleMac)]), false);
    add('mac.row.administration', administration(singleMac), false);
    add('mac.row.oui', bits.oui);
    add('mac.row.vendor', index === undefined ? t('mac.vendor.none') : vendor(singleMac), false);
    add('mac.row.linkLocal', linkLocalAddress(singleMac));
    return rows;
  });

  const detailNotes = $derived.by((): string[] => {
    if (singleMac === undefined) {
      return [];
    }
    const bits = describeMac(singleMac);
    const notes = [
      t(TYPE_DETAIL_KEYS[transmission(singleMac)]),
      t(bits.local ? 'mac.admin.local.detail' : 'mac.admin.universal.detail'),
    ];
    const noteKey = bits.note === undefined ? undefined : NOTE_KEYS[bits.note];
    if (noteKey !== undefined) {
      notes.push(t(noteKey));
    }
    return notes;
  });

  const tableRows = $derived(
    lines.map((line) => {
      if (!('mac' in line)) {
        return { line: line.line, text: line.text, error: t(ERROR_KEYS[line.error]) };
      }
      const bits = describeMac(line.mac);
      return {
        line: line.line,
        text: line.text,
        error: undefined,
        normal: formatMac(line.mac, 'colon-lower'),
        type: t(TYPE_KEYS[transmission(line.mac)]),
        admin: administration(line.mac),
        oui: bits.oui,
        vendor: index === undefined ? '' : vendor(line.mac),
      };
    }),
  );
  const columns = $derived(index === undefined ? 5 : 6);

  const message = $derived.by((): string => {
    if (fieldError !== '') {
      return fieldError;
    }
    if (singleMac !== undefined) {
      return t('mac.announce.one', {
        address: formatMac(singleMac, 'colon-lower'),
        type: t(TYPE_KEYS[transmission(singleMac)]),
        admin: administration(singleMac),
      });
    }
    const valid = lines.filter((line) => 'mac' in line).length;
    if (lines.length === 0) {
      return '';
    }
    return valid === lines.length
      ? t('mac.announce.many', { count: valid })
      : t('mac.announce.partly', { valid, total: lines.length });
  });

  /** Says the result once the new text is in. */
  async function announce(): Promise<void> {
    await tick();
    status = message;
  }

  function changed(): void {
    void announce();
  }

  /* ---- the vendor list the visitor chooses ---- */

  async function load(files: File[]): Promise<void> {
    failure = '';
    if (files.length > MAX_FILES) {
      failure = t('mac.vendor.error.tooManyFiles', { max: MAX_FILES });
      return;
    }
    pool ??= createPool();
    const own = new AbortController();
    controller = own;
    const timeoutError = new Error('reading the files took too long');
    const timeout = setTimeout(() => {
      own.abort(timeoutError);
    }, LOAD_TIMEOUT_MS);
    loading = true;
    status = t('mac.vendor.loading');
    try {
      const output = await pool.run({ files }, { signal: own.signal });
      if (controller !== own) {
        return;
      }
      if (output.ok) {
        index = new OuiIndex(output.prefixes, output.names);
        loaded = output.files;
        status = t('mac.vendor.loaded', { count: index.size });
      } else {
        status = '';
        failure = t(LOAD_ERROR_KEYS[output.error], {
          file: output.file,
          max: MAX_FILE_BYTES / (1024 * 1024),
        });
      }
    } catch {
      if (own.signal.reason === timeoutError) {
        status = '';
        failure = t('mac.vendor.error.timeout', { seconds: LOAD_TIMEOUT_MS / 1000 });
      } else if (controller === own) {
        // Not stopped by a newer choice or by "remove": the worker itself failed.
        status = '';
        failure = t('mac.vendor.error.failed');
      }
    } finally {
      clearTimeout(timeout);
      if (controller === own) {
        loading = false;
      }
    }
  }

  function onfiles(files: File[]): void {
    void load(files);
  }

  function onreject(): void {
    failure = t('mac.vendor.error.notCsv');
  }

  function remove(): void {
    controller?.abort();
    controller = undefined;
    loading = false;
    index = undefined;
    loaded = [];
    failure = '';
    status = t('mac.vendor.removed');
  }
</script>

<ToolFrame id="mac">
  <div class="tool">
    <section class="block">
      <Textarea
        keepHint
        label={t('mac.input')}
        hint={t('mac.inputHint')}
        bind:value={text}
        error={fieldError}
        announce={false}
        rows={4}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        onchange={changed}
      />
      <ToolStatus message={status} />
      <ToolStatus kind="alert" message={failure} />
    </section>

    {#if singleMac !== undefined}
      <section class="block">
        <h2 class="heading">{t('mac.results')}</h2>
        <table aria-label={t('mac.detail.caption')}>
          <thead>
            <tr>
              <th scope="col">{t('mac.col.property')}</th>
              <th scope="col">{t('mac.col.value')}</th>
              <th scope="col"><span class="visually-hidden">{t('mac.col.copy')}</span></th>
            </tr>
          </thead>
          <tbody>
            {#each detailRows as row (row.label)}
              <tr>
                <th scope="row">{row.label}</th>
                <td class="code">{row.value}</td>
                <td>
                  {#if row.copy}
                    <CopyButton
                      text={row.value}
                      label={t('mac.copy', { name: row.label })}
                      value={row.value}
                    />
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#each detailNotes as note (note)}
          <p class="note">{note}</p>
        {/each}
      </section>
    {:else if lines.length > 1}
      <section class="block wide">
        <h2 class="heading">{t('mac.results')}</h2>
        <table aria-label={t('mac.list.caption')}>
          <thead>
            <tr>
              <th scope="col">{t('mac.col.input')}</th>
              <th scope="col">{t('mac.col.normal')}</th>
              <th scope="col">{t('mac.col.type')}</th>
              <th scope="col">{t('mac.col.admin')}</th>
              <th scope="col">{t('mac.col.oui')}</th>
              {#if index !== undefined}
                <th scope="col">{t('mac.col.vendor')}</th>
              {/if}
            </tr>
          </thead>
          <tbody>
            {#each tableRows as row (row.line)}
              <tr>
                <td class="code">{row.text}</td>
                {#if row.error !== undefined}
                  <td colspan={columns - 1} class="problem">{row.error}</td>
                {:else}
                  <td class="code">{row.normal}</td>
                  <td>{row.type}</td>
                  <td>{row.admin}</td>
                  <td class="code">{row.oui}</td>
                  {#if index !== undefined}
                    <td>{row.vendor}</td>
                  {/if}
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}

    <section class="block">
      <h2 class="heading">{t('mac.vendor.title')}</h2>
      <p class="note">{t('mac.vendor.explain')}</p>
      <p class="note">
        {t('mac.vendor.source')}
        <a href={IEEE_REGISTRATION_AUTHORITY_URL} rel="external noopener noreferrer"
          >{IEEE_REGISTRATION_AUTHORITY_TEXT}</a
        >
      </p>
      <p class="note">{t('mac.vendor.privacy')}</p>
      <FileDrop
        mode="dispatch"
        rejectMessages={false}
        statusLabel=""
        dropLabel={t('mac.vendor.drop')}
        buttonLabel={t('mac.vendor.choose')}
        accept=".csv,text/csv"
        multiple={true}
        disabled={loading}
        {onfiles}
        {onreject}
      />
      {#if index !== undefined}
        <ul class="files" aria-label={t('mac.vendor.files')}>
          {#each loaded as file (file.name)}
            <li>
              {file.skipped === 0
                ? t('mac.vendor.file', { name: file.name, entries: file.entries })
                : t('mac.vendor.fileSkipped', {
                    name: file.name,
                    entries: file.entries,
                    skipped: file.skipped,
                  })}
            </li>
          {/each}
        </ul>
        <div>
          <Button variant="secondary" size="sm" onclick={remove}>{t('mac.vendor.remove')}</Button>
        </div>
      {/if}
    </section>
  </div>
</ToolFrame>

<style>
  .tool {
    display: flex;
    flex-direction: column;
    gap: var(--space-40);
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-16);
    max-width: 760px;
  }

  .block.wide {
    max-width: none;
  }

  .heading {
    margin: 0;
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.4px;
  }

  .note {
    margin: 0;
    font: 13px/1.5 var(--mono);
    color: var(--mut);
    overflow-wrap: anywhere;
  }

  /* A link inside a sentence is told apart by more than its colour (WCAG 1.4.1). */
  .note a {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .files {
    margin: 0;
    padding: 0;
    list-style: none;
    font: 13px var(--mono);
    overflow-wrap: anywhere;
  }

  table {
    border-collapse: collapse;
    width: 100%;
    font: 14px var(--mono);
  }

  th,
  td {
    padding: var(--space-8) var(--space-12);
    border-bottom: 1px solid var(--line);
    text-align: left;
    font-weight: 400;
    vertical-align: middle;
    overflow-wrap: anywhere;
  }

  thead th,
  tbody th {
    color: var(--mut);
  }

  .problem {
    color: var(--pink2);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
