<script lang="ts">
  import { Input, Button, StatusMessage } from '@mozra-the-great/kern';
  import { t, type MessageKey } from '../../i18n/index.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import {
    MAX_USER_AGENT_LENGTH,
    parseUserAgent,
    type DeviceType,
    type Named,
    type UserAgentNote,
  } from './user-agent.ts';

  const TYPE_KEYS: Readonly<Record<DeviceType, MessageKey>> = {
    desktop: 'ua.type.desktop',
    mobile: 'ua.type.mobile',
    tablet: 'ua.type.tablet',
    tv: 'ua.type.tv',
    console: 'ua.type.console',
    wearable: 'ua.type.wearable',
    bot: 'ua.type.bot',
    library: 'ua.type.library',
    unknown: 'ua.type.unknown',
  };

  const NOTE_KEYS: Readonly<Record<UserAgentNote, MessageKey>> = {
    'windows-10-11': 'ua.note.windows',
    'frozen-macos': 'ua.note.macos',
    'reduced-device': 'ua.note.reduced',
  };

  let text = $state('');
  let status = $state('');

  const tooLong = $derived(text.length > MAX_USER_AGENT_LENGTH);
  const problem = $derived(tooLong ? t('ua.tooLong', { max: MAX_USER_AGENT_LENGTH }) : '');
  const info = $derived(text.trim() === '' || tooLong ? undefined : parseUserAgent(text));

  function show(named: Named | undefined): string {
    if (named === undefined) {
      return t('ua.unknown');
    }
    return named.version === undefined ? named.name : `${named.name} ${named.version}`;
  }

  const rows = $derived.by(() => {
    if (info === undefined) {
      return [];
    }
    const device = [info.device.vendor, info.device.model].filter((part) => part !== undefined);
    return [
      { key: 'browser', label: t('ua.row.browser'), value: show(info.browser) },
      { key: 'engine', label: t('ua.row.engine'), value: show(info.engine) },
      { key: 'os', label: t('ua.row.os'), value: show(info.os) },
      {
        key: 'device',
        label: t('ua.row.device'),
        value: device.length > 0 ? device.join(' ') : t('ua.unknown'),
      },
      { key: 'type', label: t('ua.row.type'), value: t(TYPE_KEYS[info.device.type]) },
      { key: 'cpu', label: t('ua.row.cpu'), value: info.cpu ?? t('ua.unknown') },
    ];
  });

  /** The result as text for the clipboard: JSON with English names, whatever the language. */
  const json = $derived(info === undefined ? '' : JSON.stringify(info, null, 2));

  function summary(): string {
    if (info === undefined) {
      return problem;
    }
    const type = t(TYPE_KEYS[info.device.type]);
    if (info.browser !== undefined && info.os !== undefined) {
      return t('ua.announce.full', { browser: show(info.browser), os: show(info.os), type });
    }
    if (info.browser !== undefined) {
      return t('ua.announce.browser', { browser: show(info.browser), type });
    }
    return info.os === undefined
      ? t('ua.announce.none')
      : t('ua.announce.os', { os: show(info.os), type });
  }

  function announce(): void {
    status = text.trim() === '' ? '' : summary();
  }

  /** Opt-in: only when the button is pressed is the browser's own string read, and it goes nowhere. */
  function useMine(): void {
    text = globalThis.navigator.userAgent;
    announce();
  }

  function clear(): void {
    text = '';
    status = '';
  }
</script>

<!--
  kern has a DataTable for this result table; it stays a plain <table> with row headers for now (follow-up
  #202, ADR 0014 final addendum).
-->
<ToolFrame id="user-agent">
  <div class="tool">
    <section class="block">
      <Input
        keepHint
        label={t('ua.input')}
        hint={t('ua.inputHint')}
        bind:value={text}
        error={problem}
        announce={false}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        onchange={announce}
      />
      <div class="actions">
        <Button variant="secondary" size="sm" onclick={useMine}>{t('ua.use')}</Button>
        <Button variant="secondary" size="sm" onclick={clear}>{t('ua.clear')}</Button>
      </div>
      <p class="note">{t('ua.useHint')}</p>
      <StatusMessage data-tool-status tone="ok" message={status} />
    </section>

    <section class="block">
      <h2 class="heading">{t('ua.result')}</h2>
      {#if info === undefined}
        <p class="note">{t('ua.empty')}</p>
      {:else}
        <table>
          <tbody>
            {#each rows as row (row.key)}
              <tr>
                <th scope="row">{row.label}</th>
                <td>{row.value}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div>
          <CopyButton text={json} label={t('ua.copy')} value={t('ua.result')} />
        </div>
        <h2 class="heading">{t('ua.notes')}</h2>
        <ul class="notes">
          {#each info.notes as note (note)}
            <li>{t(NOTE_KEYS[note])}</li>
          {/each}
          <li>{t('ua.note.spoofable')}</li>
        </ul>
      {/if}
    </section>
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

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--k-space-3);
  }

  .note {
    margin: 0;
    font: 13px var(--k-font-mono);
    color: var(--k-fg-muted);
  }

  .notes {
    margin: 0;
    padding-left: var(--k-space-5);
    font: 14px/1.5 var(--k-font-mono);
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
    overflow-wrap: anywhere;
  }

  th {
    color: var(--k-fg-muted);
    width: 40%;
  }
</style>
