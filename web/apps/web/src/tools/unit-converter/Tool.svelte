<script lang="ts">
  import { Input, Select, Button } from '@mozra-the-great/kern';
  import { i18n, t, type MessageKey } from '../../i18n/index.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import ToolStatus from '../../app/ToolStatus.svelte';
  import {
    categoryName,
    categoryOrFirst,
    CATEGORIES,
    convert,
    convertAll,
    DEFAULT_PRECISION,
    formatValue,
    localizeNumber,
    MAX_PRECISION,
    MIN_PRECISION,
    parseNumber,
    parsePrecision,
    searchUnits,
    unitName,
    unitOrFirst,
    type CategoryId,
    type UnitHit,
  } from './units.ts';

  const NOTE_KEYS: Partial<Record<CategoryId, MessageKey>> = {
    data: 'units.note.data',
    time: 'units.note.time',
    volume: 'units.note.volume',
  };

  let categoryId = $state<string>('length');
  let fromId = $state('km');
  let toId = $state('mi');
  let valueText = $state('1');
  let precisionText = $state(String(DEFAULT_PRECISION));
  let query = $state('');
  let status = $state('');

  const category = $derived(categoryOrFirst(categoryId));
  const from = $derived(unitOrFirst(category, fromId));
  const to = $derived(unitOrFirst(category, toId));
  const precision = $derived(parsePrecision(precisionText));
  const parsed = $derived(parseNumber(valueText));
  const conversion = $derived(parsed.ok ? convert(category, from, to, parsed.value) : undefined);
  const all = $derived(parsed.ok ? convertAll(category, from, parsed.value) : []);
  const hits = $derived(searchUnits(query));
  const note = $derived(NOTE_KEYS[category.id]);

  const categoryOptions = $derived(
    CATEGORIES.map((entry) => ({ value: entry.id, label: categoryName(entry, i18n.locale) })),
  );
  const unitOptions = $derived(
    category.units.map((unit) => ({
      value: unit.id,
      label: `${unitName(unit, i18n.locale)} (${unit.symbol})`,
    })),
  );

  const ERRORS = {
    empty: 'units.error.empty',
    syntax: 'units.error.syntax',
    range: 'units.error.range',
    'below-absolute-zero': 'units.error.belowAbsoluteZero',
    overflow: 'units.error.overflow',
  } as const satisfies Record<string, MessageKey>;

  /** Why there is no result, as text; empty when there is one. */
  const problem = $derived.by(() => {
    if (!parsed.ok) {
      return t(ERRORS[parsed.error]);
    }
    return conversion !== undefined && !conversion.ok ? t(ERRORS[conversion.error]) : '';
  });

  /** A number as it is shown: the digits chosen, the decimal separator of the language. */
  function show(value: number): string {
    return localizeNumber(formatValue(value, precision), i18n.locale);
  }

  const resultText = $derived(conversion?.ok === true ? show(conversion.value) : '');

  const searchStatus = $derived(
    query.trim() === ''
      ? ''
      : hits.length === 0
        ? t('units.search.none')
        : t('units.search.count', { count: hits.length }),
  );

  function announceResult(): void {
    status =
      problem !== ''
        ? problem
        : t('units.announce', {
            value: valueText.trim(),
            from: unitName(from, i18n.locale),
            result: resultText,
            to: unitName(to, i18n.locale),
          });
  }

  function setCategory(id: string): void {
    const next = categoryOrFirst(id);
    categoryId = next.id;
    [fromId, toId] = next.defaults;
    announceResult();
  }

  type SelectEvent = Event & { currentTarget: HTMLSelectElement };

  function onCategory(event: SelectEvent): void {
    setCategory(event.currentTarget.value);
  }

  function onFrom(event: SelectEvent): void {
    fromId = event.currentTarget.value;
    announceResult();
  }

  function onTo(event: SelectEvent): void {
    toId = event.currentTarget.value;
    announceResult();
  }

  // Not `bind:value`: on a number field Svelte binds a number (or null when it is empty).
  function onPrecision(event: Event & { currentTarget: HTMLInputElement }): void {
    precisionText = event.currentTarget.value;
  }

  function swap(): void {
    [fromId, toId] = [to.id, from.id];
    announceResult();
  }

  function useHit(hit: UnitHit, role: 'from' | 'to'): void {
    if (hit.category.id !== category.id) {
      categoryId = hit.category.id;
      [fromId, toId] = hit.category.defaults;
    }
    if (role === 'from') {
      fromId = hit.unit.id;
    } else {
      toId = hit.unit.id;
    }
    announceResult();
  }
</script>

<ToolFrame id="unit-converter">
  <div class="tool">
    <section class="block">
      <Input
        type="search"
        label={t('units.search.label')}
        hint={t('units.search.hint')}
        bind:value={query}
        spellcheck={false}
        autocomplete="off"
      />
      <ToolStatus message={searchStatus} />
      {#if hits.length > 0}
        <ul class="hits" aria-label={t('units.search.results')}>
          {#each hits as hit (`${hit.category.id}/${hit.unit.id}`)}
            {@const name = unitName(hit.unit, i18n.locale)}
            <li>
              <span class="hit-name">{name} ({hit.unit.symbol})</span>
              <span class="hit-category">{categoryName(hit.category, i18n.locale)}</span>
              <Button
                variant="secondary"
                size="sm"
                aria-label={t('units.search.asFrom', { unit: name })}
                onclick={() => {
                  useHit(hit, 'from');
                }}>{t('units.search.from')}</Button
              >
              <Button
                variant="secondary"
                size="sm"
                aria-label={t('units.search.asTo', { unit: name })}
                onclick={() => {
                  useHit(hit, 'to');
                }}>{t('units.search.to')}</Button
              >
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="block">
      <div class="grid">
        <Select
          label={t('units.category')}
          options={categoryOptions}
          value={category.id}
          onchange={onCategory}
        />
        <Input
          label={t('units.value')}
          inputmode="decimal"
          autocomplete="off"
          spellcheck={false}
          bind:value={valueText}
          error={problem}
          onchange={announceResult}
        />
        <Select label={t('units.from')} options={unitOptions} value={from.id} onchange={onFrom} />
        <Select label={t('units.to')} options={unitOptions} value={to.id} onchange={onTo} />
      </div>
      <div class="actions">
        <Button variant="secondary" size="sm" onclick={swap}>{t('units.swap')}</Button>
        <div class="precision">
          <Input
            type="number"
            inputmode="numeric"
            min={MIN_PRECISION}
            max={MAX_PRECISION}
            step={1}
            label={t('units.precision')}
            hint={t('units.precisionHint')}
            value={precisionText}
            oninput={onPrecision}
            onchange={announceResult}
          />
        </div>
      </div>
      <ToolStatus message={status} />
    </section>

    <section class="block">
      <h2 class="heading">{t('units.result')}</h2>
      {#if conversion?.ok === true}
        <div class="result">
          <p class="equation">
            <span class="number">{resultText}</span>
            <span class="symbol">{to.symbol}</span>
          </p>
          <CopyButton
            text={resultText}
            label={t('units.copy')}
            value={`${resultText} ${to.symbol}`}
          />
        </div>
      {:else}
        <p class="equation muted">—</p>
      {/if}
      {#if note !== undefined}
        <p class="note">{t(note)}</p>
      {/if}
    </section>

    {#if conversion?.ok === true}
      <section class="block">
        <h2 class="heading">{t('units.all')}</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">{t('units.col.unit')}</th>
              <th scope="col">{t('units.col.symbol')}</th>
              <th scope="col">{t('units.col.value')}</th>
            </tr>
          </thead>
          <tbody>
            {#each all as entry (entry.unit.id)}
              <tr>
                <th scope="row">{unitName(entry.unit, i18n.locale)}</th>
                <td>{entry.unit.symbol}</td>
                <td class="value">{entry.result.ok ? show(entry.result.value) : '—'}</td>
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

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-20);
  }

  .precision {
    width: 220px;
  }

  .result {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-16);
  }

  .equation {
    margin: 0;
    font: 500 36px/1.2 var(--mono);
    overflow-wrap: anywhere;
  }

  .equation.muted {
    color: var(--mut);
  }

  .symbol {
    color: var(--mut);
  }

  .note {
    margin: 0;
    font: 13px var(--mono);
    color: var(--mut);
  }

  .hits {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--line);
  }

  .hits li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-12);
    padding: var(--space-8) var(--space-12);
    border-bottom: 1px solid var(--line);
  }

  .hits li:last-child {
    border-bottom: 0;
  }

  .hit-name {
    flex: 1;
    min-width: 16ch;
    font: 15px var(--mono);
  }

  .hit-category {
    font: 12px var(--mono);
    letter-spacing: 1px;
    color: var(--mut);
    text-transform: uppercase;
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
  }

  thead th {
    color: var(--mut);
  }

  td.value {
    overflow-wrap: anywhere;
  }
</style>
