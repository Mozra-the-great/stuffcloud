<script lang="ts">
  import { Input, Select, Button, VisuallyHidden, StatusMessage } from '@mozra-the-great/kern';
  import { i18n, t, type MessageKey } from '../../i18n/index.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import { listTimeZones } from '../cron/time-zone.ts';
  import { relativeTime } from './relative.ts';
  import {
    MAX_INPUT_LENGTH,
    browserTimeZone,
    formatInstant,
    parseInstant,
    type EpochUnit,
    type ParseErrorCode,
  } from './timestamp.ts';

  const ERROR_KEYS: Readonly<Record<ParseErrorCode, MessageKey>> = {
    empty: 'timestamp.error.empty',
    'too-long': 'timestamp.error.tooLong',
    format: 'timestamp.error.format',
    range: 'timestamp.error.range',
    date: 'timestamp.error.date',
    time: 'timestamp.error.time',
    offset: 'timestamp.error.offset',
    gap: 'timestamp.error.gap',
  };

  let input = $state(String(Math.floor(Date.now() / 1000)));
  let unit = $state<EpochUnit>('auto');
  let timeZone = $state(browserTimeZone());
  let status = $state('');

  const zoneOptions = listTimeZones().map((name) => ({ value: name, label: name }));
  const unitOptions = $derived([
    { value: 'auto', label: t('timestamp.unit.auto') },
    { value: 'seconds', label: t('timestamp.unit.seconds') },
    { value: 'milliseconds', label: t('timestamp.unit.milliseconds') },
  ]);

  const parsed = $derived(parseInstant(input, unit, timeZone));
  const problem = $derived(
    parsed.ok ? '' : t(ERROR_KEYS[parsed.error], { max: MAX_INPUT_LENGTH, zone: timeZone }),
  );
  const formats = $derived(parsed.ok ? formatInstant(parsed.ms, timeZone, i18n.locale) : undefined);
  const relative = $derived(parsed.ok ? relativeTime(parsed.ms - Date.now(), i18n.locale) : '');

  const note = $derived.by((): string => {
    if (!parsed.ok) {
      return '';
    }
    if (parsed.kind === 'iso') {
      return parsed.ambiguous ? t('timestamp.note.ambiguous', { zone: timeZone }) : '';
    }
    if (unit !== 'auto') {
      return '';
    }
    return t(parsed.kind === 'seconds' ? 'timestamp.note.seconds' : 'timestamp.note.milliseconds');
  });

  const rows = $derived.by((): { label: string; value: string; copy: string }[] => {
    if (formats === undefined) {
      return [];
    }
    const list: { label: string; value: string; copy: string }[] = [
      {
        label: t('timestamp.row.seconds'),
        value: formats.seconds,
        copy: t('timestamp.copy.seconds'),
      },
      {
        label: t('timestamp.row.milliseconds'),
        value: formats.milliseconds,
        copy: t('timestamp.copy.milliseconds'),
      },
      { label: t('timestamp.row.isoUtc'), value: formats.isoUtc, copy: t('timestamp.copy.isoUtc') },
    ];
    if (formats.isoZone !== undefined) {
      list.push({
        label: t('timestamp.row.isoZone', { zone: timeZone }),
        value: formats.isoZone,
        copy: t('timestamp.copy.isoZone'),
      });
    }
    if (formats.local !== undefined) {
      list.push({
        label: t('timestamp.row.local', { zone: timeZone }),
        value: formats.local,
        copy: t('timestamp.copy.local'),
      });
    }
    list.push({
      label: t('timestamp.row.http'),
      value: formats.http,
      copy: t('timestamp.copy.http'),
    });
    return list;
  });

  function announce(): void {
    status =
      formats === undefined ? problem : t('timestamp.announce', { iso: formats.isoUtc, relative });
  }

  function useNow(): void {
    const now = Date.now();
    input = unit === 'milliseconds' ? String(now) : String(Math.floor(now / 1000));
    status = t('timestamp.announce.now');
  }
</script>

<ToolFrame id="timestamp">
  <div class="tool">
    <section class="block">
      <Input
        keepHint
        label={t('timestamp.input')}
        hint={t('timestamp.inputHint')}
        bind:value={input}
        error={problem}
        announce={false}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        onchange={announce}
      />
      <div class="grid">
        <Select
          label={t('timestamp.unit')}
          options={unitOptions}
          bind:value={unit}
          onchange={announce}
        />
        <Select
          label={t('timestamp.timeZone')}
          options={zoneOptions}
          bind:value={timeZone}
          onchange={announce}
        />
      </div>
      <div>
        <Button variant="secondary" onclick={useNow}>{t('timestamp.now')}</Button>
      </div>
      <StatusMessage data-tool-status class="tool-ok" message={status} />
    </section>

    {#if formats !== undefined}
      <section class="block">
        <h2 class="heading">{t('timestamp.results')}</h2>
        <p class="relative">{relative}</p>
        {#if note !== ''}
          <p class="note">{note}</p>
        {/if}
        <table aria-label={t('timestamp.results.caption')}>
          <thead>
            <tr>
              <th scope="col">{t('timestamp.col.format')}</th>
              <th scope="col">{t('timestamp.col.value')}</th>
              <th scope="col"><VisuallyHidden>{t('timestamp.col.copy')}</VisuallyHidden></th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.label)}
              <tr>
                <th scope="row">{row.label}</th>
                <td class="code">{row.value}</td>
                <td><CopyButton text={row.value} label={row.copy} value={row.value} /></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}
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

  .heading {
    margin: 0;
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.4px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-20);
  }

  .relative {
    margin: 0;
    font: 500 22px/1.4 var(--mono);
  }

  .note {
    margin: 0;
    font: 13px var(--mono);
    color: var(--mut);
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
</style>
