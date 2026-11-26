<script lang="ts">
  import { Select, Button, Textarea, StatusMessage } from '@mozra-the-great/kern';
  import { t, type MessageKey } from '../../i18n/index.ts';
  import DownloadButton from '../../app/DownloadButton.svelte';
  import CopyButton from '../../app/CopyButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import { formatSql } from './layout.ts';
  import { DIALECTS, isDialect, type Dialect, type KeywordCase } from './tokens.ts';

  /** The longest text the page formats. */
  const MAX_CHARS = 1_000_000;
  const STATUS_DELAY_MS = 400;
  const SAMPLE =
    "select u.id, u.name, count(o.id) as orders from users u left join orders o on o.user_id = u.id and o.status = 'paid' where u.created_at >= '2026-01-01' and u.country in ('DE', 'AT') group by u.id, u.name having count(o.id) > 2 order by orders desc limit 10;";

  const DIALECT_KEYS: Readonly<Record<Dialect, MessageKey>> = {
    standard: 'sql.dialect.standard',
    postgresql: 'sql.dialect.postgresql',
    mysql: 'sql.dialect.mysql',
    sqlite: 'sql.dialect.sqlite',
    sqlserver: 'sql.dialect.sqlserver',
    oracle: 'sql.dialect.oracle',
  };

  type Layout = '2' | '4' | 'tab' | 'min';

  let text = $state(SAMPLE);
  let dialect = $state<Dialect>('standard');
  let keywordCase = $state<KeywordCase>('upper');
  let layout = $state<Layout>('2');
  let status = $state('');
  let failure = $state('');

  const dialectOptions = $derived(
    DIALECTS.map((value) => ({ value, label: t(DIALECT_KEYS[value]) })),
  );
  const caseOptions = $derived([
    { value: 'upper', label: t('sql.case.upper') },
    { value: 'lower', label: t('sql.case.lower') },
    { value: 'preserve', label: t('sql.case.preserve') },
  ]);
  const layoutOptions = $derived([
    { value: '2', label: t('sql.indent.2') },
    { value: '4', label: t('sql.indent.4') },
    { value: 'tab', label: t('sql.indent.tab') },
    { value: 'min', label: t('sql.indent.min') },
  ]);

  const tooLong = $derived(text.length > MAX_CHARS);
  const output = $derived(
    tooLong || text.trim() === ''
      ? undefined
      : formatSql(text, {
          dialect,
          keywordCase,
          indent: layout === 'tab' ? 'tab' : layout === 'min' ? 2 : Number(layout),
          minify: layout === 'min',
        }),
  );

  // What is said waits for a pause in typing, so that a screen reader is not told about every key.
  $effect(() => {
    const message =
      output === undefined
        ? tooLong
          ? ''
          : t('sql.empty')
        : t('sql.done', { lines: output.split('\n').length });
    const alert = tooLong ? t('sql.tooLong', { max: MAX_CHARS }) : '';
    const timer = setTimeout(() => {
      status = message;
      failure = alert;
    }, STATUS_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  });
</script>

<ToolFrame id="sql-formatter">
  <div class="tool">
    <section class="block">
      <Textarea
        label={t('sql.input')}
        bind:value={text}
        rows={12}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
      />
      <div class="options">
        <Select
          label={t('sql.dialect')}
          hint={t('sql.dialectHint')}
          options={dialectOptions}
          value={dialect}
          onchange={(event: Event & { currentTarget: HTMLSelectElement }) => {
            if (isDialect(event.currentTarget.value)) {
              dialect = event.currentTarget.value;
            }
          }}
        />
        <Select
          label={t('sql.case')}
          options={caseOptions}
          value={keywordCase}
          onchange={(event: Event & { currentTarget: HTMLSelectElement }) => {
            const value = event.currentTarget.value;
            if (value === 'upper' || value === 'lower' || value === 'preserve') {
              keywordCase = value;
            }
          }}
        />
        <Select label={t('sql.indent')} options={layoutOptions} bind:value={layout} />
      </div>
      <StatusMessage data-tool-status tone="ok" message={status} />
      <StatusMessage data-tool-status kind="alert" message={failure} />
    </section>

    {#if output !== undefined}
      <section class="block">
        <h2 class="heading">{t('sql.result')}</h2>
        <Textarea label={t('sql.result')} value={output} readonly rows={14} spellcheck={false} />
        <div class="row">
          <CopyButton text={output} label={t('sql.copy')} value={t('sql.copied')} />
          <DownloadButton
            label={t('sql.download')}
            name="formatted.sql"
            text={output}
            type="application/sql"
          />
          <Button
            variant="secondary"
            size="sm"
            onclick={() => {
              text = output;
            }}>{t('sql.useAsInput')}</Button
          >
        </div>
      </section>
    {/if}
    <p class="note">{t('sql.note')}</p>
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

  .options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-16);
    align-items: start;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-12);
  }

  .note {
    margin: 0;
    max-width: 760px;
    font: 13px/1.5 var(--mono);
    color: var(--mut);
  }
</style>
