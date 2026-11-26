<script lang="ts">
  import { Input, Select, StatusMessage } from '@mozra-the-great/kern';
  import { i18n, t } from '../../i18n/index.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import { parseCron, type CronError } from './cron.ts';
  import { explainCron } from './explain.ts';
  import { ERROR_KEYS, FIELD_KEYS } from './messages.ts';
  import { DEFAULT_RUNS, MAX_RUNS, MIN_RUNS, nextRuns } from './next-runs.ts';
  import { browserTimeZone, listTimeZones } from './time-zone.ts';

  let expression = $state('*/15 9-17 * * 1-5');
  let timeZone = $state(browserTimeZone());
  let countText = $state(String(DEFAULT_RUNS));
  let status = $state('');

  const zoneOptions = listTimeZones().map((name) => ({ value: name, label: name }));

  const parsed = $derived(parseCron(expression));
  const schedule = $derived(parsed.ok ? parsed.schedule : undefined);

  /** The number of runs asked for, or `undefined` when the field does not hold one. */
  const count = $derived.by((): number | undefined => {
    const text = countText.trim();
    if (!/^\d{1,3}$/.test(text)) {
      return undefined;
    }
    const value = Number(text);
    return value >= MIN_RUNS && value <= MAX_RUNS ? value : undefined;
  });

  function errorText(error: CronError): string {
    return t(ERROR_KEYS[error.code], {
      field: error.field === undefined ? '' : t(FIELD_KEYS[error.field]),
      token: error.token ?? '',
      min: error.min ?? 0,
      max: error.max ?? 0,
      count: error.count ?? 0,
    });
  }

  const problem = $derived(parsed.ok ? '' : parsed.errors.map(errorText).join(' '));
  const explanation = $derived(schedule === undefined ? '' : explainCron(schedule, i18n.locale));

  // The runs are computed from the moment the expression, zone or count last changed.
  const runs = $derived.by(() => {
    if (schedule === undefined || count === undefined) {
      return undefined;
    }
    return nextRuns(schedule, { from: Date.now(), count, timeZone });
  });

  const withSeconds = $derived(schedule?.second !== undefined);
  const localFormat = $derived(
    new Intl.DateTimeFormat(i18n.locale, {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: withSeconds ? '2-digit' : undefined,
      hourCycle: 'h23',
      timeZoneName: 'short',
    }),
  );

  function utc(instant: number): string {
    return new Date(instant).toISOString().slice(0, 19).replace('T', ' ');
  }

  function announce(): void {
    if (schedule === undefined) {
      status = problem;
      return;
    }
    const first = runs?.runs[0];
    status =
      first === undefined
        ? explanation
        : t('cron.announce.runs', { explanation, next: localFormat.format(first) });
  }

  // Not `bind:value`: on a number field Svelte binds a number (or null when it is empty).
  function onCount(event: Event & { currentTarget: HTMLInputElement }): void {
    countText = event.currentTarget.value;
  }
</script>

<!--
  kern has a DataTable for the table of runs and a Combobox for the time zone list (about 420 names); they stay a
  plain <table> and the base Select for now (follow-up #202, ADR 0014 final addendum).
-->
<ToolFrame id="cron">
  <div class="tool">
    <section class="block">
      <Input
        keepHint
        label={t('cron.expression')}
        hint={t('cron.expressionHint')}
        bind:value={expression}
        error={problem}
        announce={false}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        onchange={announce}
      />
      <div class="grid">
        <Select
          label={t('cron.timeZone')}
          options={zoneOptions}
          bind:value={timeZone}
          onchange={announce}
        />
        <Input
          keepHint
          type="number"
          inputmode="numeric"
          min={MIN_RUNS}
          max={MAX_RUNS}
          step={1}
          label={t('cron.count')}
          hint={t('cron.countHint')}
          error={count === undefined ? t('cron.countError') : ''}
          value={countText}
          oninput={onCount}
          onchange={announce}
        />
      </div>
      <StatusMessage data-tool-status tone="ok" message={status} />
    </section>

    {#if schedule !== undefined}
      <section class="block">
        <h2 class="heading">{t('cron.explanation')}</h2>
        <div class="result">
          <p class="explanation">{explanation}</p>
          <CopyButton text={explanation} label={t('cron.copy')} />
        </div>
        {#if schedule.macro !== undefined}
          <p class="note">{t('cron.equivalent', { expression: schedule.normalized })}</p>
        {/if}
        {#if schedule.dayRule === 'or'}
          <p class="note">{t('cron.note.dayOr')}</p>
        {:else if schedule.dayRule === 'and'}
          <p class="note">{t('cron.note.dayAnd')}</p>
        {/if}
        {#if schedule.dialect !== 'standard'}
          <p class="note">{t('cron.note.numbers')}</p>
        {/if}
      </section>

      <section class="block">
        <h2 class="heading">{t('cron.runs')}</h2>
        {#if runs !== undefined && runs.runs.length > 0}
          <table aria-label={t('cron.runs.caption')}>
            <thead>
              <tr>
                <th scope="col">{t('cron.runs.number')}</th>
                <th scope="col">{t('cron.runs.local', { zone: timeZone })}</th>
                <th scope="col">{t('cron.runs.utc')}</th>
              </tr>
            </thead>
            <tbody>
              {#each runs.runs as instant, index (instant)}
                <tr>
                  <th scope="row">{index + 1}</th>
                  <td>{localFormat.format(instant)}</td>
                  <td>{utc(instant)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if runs.exhausted}
            <p class="note">{t('cron.runs.fewer', { count: runs.runs.length })}</p>
          {/if}
          <p class="note">{t('cron.note.dst')}</p>
        {:else if runs !== undefined}
          <p class="note">{t('cron.runs.none')}</p>
        {/if}
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

  .result {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-16);
  }

  .explanation {
    margin: 0;
    font: 500 22px/1.4 var(--mono);
    overflow-wrap: anywhere;
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
    overflow-wrap: anywhere;
  }

  thead th {
    color: var(--mut);
  }
</style>
