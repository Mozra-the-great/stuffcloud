<script lang="ts">
  import { Input, Select, Button, Checkbox, Textarea, StatusMessage } from '@mozra-the-great/kern';
  import type { WorkerPool } from '@stuffcloud/tools';
  import { i18n, t, type MessageKey } from '../../i18n/index.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import DownloadButton from '../../app/DownloadButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import { CASE_STYLES, type CaseStyle } from './case.ts';
  import type { Counts } from './count.ts';
  import type { TrimMode } from './lines.ts';
  import { createPool } from './pool.ts';
  import type { SlugSeparator } from './slug.ts';
  import {
    MAX_FIND_LENGTH,
    MAX_SEPARATOR_LENGTH,
    MAX_START,
    MAX_TEXT_LENGTH,
    OPERATIONS,
    TASK_TIMEOUT_MS,
    type Input as TaskInput,
    type Operation,
    type Output as TaskOutput,
    type Request,
    type Result,
  } from './task.ts';

  /** Typing waits this long for a pause before the text is processed. */
  const DEBOUNCE_MS = 250;

  let text = $state('Hello World\nhello world\nZebra\napple\n  Apple  \nitem 10\nitem 2\n');
  let operation = $state<Operation>('case');

  let caseStyle = $state<CaseStyle>('upper');
  let sortDescending = $state(false);
  let sortIgnoreCase = $state(false);
  let sortNumeric = $state(true);
  let dedupeIgnoreCase = $state(false);
  let dedupeIgnoreWhitespace = $state(false);
  let trimMode = $state<TrimMode>('both');
  let trimRemoveEmpty = $state(false);
  let trimCollapse = $state(false);
  let startText = $state('1');
  let separator = $state(': ');
  let pad = $state(true);
  let find = $state('');
  let replacement = $state('');
  let regex = $state(false);
  let findIgnoreCase = $state(false);
  let wholeWord = $state(false);
  let slugSeparator = $state<SlugSeparator>('-');
  let asciiOnly = $state(true);
  let germanUmlauts = $state(i18n.locale === 'de');

  let result = $state<Result | null>(null);
  let counts = $state<Counts | undefined>(undefined);
  let working = $state(false);
  let status = $state('');
  let failure = $state('');

  let pool: WorkerPool<TaskInput, TaskOutput> | undefined;
  let controller: AbortController | undefined;

  $effect(() => () => {
    controller?.abort();
    pool?.terminate();
  });

  const textError = $derived(
    text.length > MAX_TEXT_LENGTH ? t('textops.tooLong', { max: MAX_TEXT_LENGTH }) : '',
  );

  const start = $derived(/^-?\d{1,10}$/.test(startText.trim()) ? Number(startText.trim()) : NaN);
  const startError = $derived(
    operation === 'number' && !(Number.isInteger(start) && Math.abs(start) <= MAX_START)
      ? t('textops.startError', { max: MAX_START })
      : '',
  );
  const separatorError = $derived(
    operation === 'number' && separator.length > MAX_SEPARATOR_LENGTH
      ? t('textops.separatorError', { max: MAX_SEPARATOR_LENGTH })
      : '',
  );
  const findError = $derived(
    operation === 'replace' && find.length > MAX_FIND_LENGTH
      ? t('textops.findLong', { max: MAX_FIND_LENGTH })
      : result?.ok === false && result.error.code === 'pattern'
        ? t('textops.patternError', { message: result.error.message })
        : '',
  );

  /** What to do, or `null` while the options are not complete. */
  const request = $derived.by((): Request | null => {
    switch (operation) {
      case 'case':
        return { operation, style: caseStyle };
      case 'sort':
        return {
          operation,
          descending: sortDescending,
          ignoreCase: sortIgnoreCase,
          numeric: sortNumeric,
          locale: i18n.locale,
        };
      case 'dedupe':
        return {
          operation,
          ignoreCase: dedupeIgnoreCase,
          ignoreWhitespace: dedupeIgnoreWhitespace,
        };
      case 'trim':
        return {
          operation,
          mode: trimMode,
          removeEmptyLines: trimRemoveEmpty,
          collapse: trimCollapse,
        };
      case 'number':
        return startError === '' && separatorError === ''
          ? { operation, start, separator, pad }
          : null;
      case 'replace':
        return find === '' || find.length > MAX_FIND_LENGTH
          ? null
          : { operation, find, replacement, regex, ignoreCase: findIgnoreCase, wholeWord };
      case 'slug':
        return { operation, separator: slugSeparator, asciiOnly, germanUmlauts };
    }
  });

  // The text is processed when typing pauses, in a worker that is stopped when it takes too long.
  $effect(() => {
    if (textError !== '') {
      controller?.abort();
      controller = undefined;
      result = null;
      counts = undefined;
      working = false;
      status = '';
      failure = '';
      return;
    }
    const input: TaskInput = { text, request };
    const timer = setTimeout(() => {
      void run(input);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  });

  async function run(input: TaskInput): Promise<void> {
    controller?.abort();
    pool ??= createPool();
    const own = new AbortController();
    controller = own;
    const timeoutError = new Error('the operation took too long');
    const timeout = setTimeout(() => {
      own.abort(timeoutError);
    }, TASK_TIMEOUT_MS);
    working = true;
    try {
      const output = await pool.run(input, { signal: own.signal });
      if (controller !== own) {
        return;
      }
      result = output.result;
      counts = output.counts;
      failure = '';
      status = describe(output.result);
    } catch {
      if (own.signal.reason === timeoutError) {
        result = null;
        status = '';
        failure = t('textops.timeout', { seconds: TASK_TIMEOUT_MS / 1000 });
      } else if (controller === own) {
        // Not stopped by a newer edit: the worker itself failed.
        result = null;
        status = '';
        failure = t('textops.failed');
      }
    } finally {
      clearTimeout(timeout);
      if (controller === own) {
        working = false;
      }
    }
  }

  function describe(output: Result | null): string {
    if (output?.ok !== true) {
      return '';
    }
    if (output.detail?.kind === 'replaced') {
      return t('textops.replaced', { count: output.detail.count });
    }
    if (output.detail?.kind === 'removed') {
      return t('textops.removed', { count: output.detail.count });
    }
    return t('textops.done');
  }

  const resultText = $derived(result?.ok === true ? result.text : '');

  const OPERATION_KEYS: Readonly<Record<Operation, MessageKey>> = {
    case: 'textops.op.case',
    sort: 'textops.op.sort',
    dedupe: 'textops.op.dedupe',
    trim: 'textops.op.trim',
    number: 'textops.op.number',
    replace: 'textops.op.replace',
    slug: 'textops.op.slug',
  };
  const operationOptions = $derived(
    OPERATIONS.map((value) => ({ value, label: t(OPERATION_KEYS[value]) })),
  );
  const CASE_KEYS: Readonly<Record<CaseStyle, MessageKey>> = {
    upper: 'textops.case.upper',
    lower: 'textops.case.lower',
    title: 'textops.case.title',
    sentence: 'textops.case.sentence',
    camel: 'textops.case.camel',
    pascal: 'textops.case.pascal',
    snake: 'textops.case.snake',
    kebab: 'textops.case.kebab',
    constant: 'textops.case.constant',
  };
  const caseOptions = $derived(CASE_STYLES.map((value) => ({ value, label: t(CASE_KEYS[value]) })));
  const trimOptions = $derived([
    { value: 'both', label: t('textops.trim.both') },
    { value: 'start', label: t('textops.trim.start') },
    { value: 'end', label: t('textops.trim.end') },
  ]);
  const slugOptions = $derived([
    { value: '-', label: t('textops.slug.hyphen') },
    { value: '_', label: t('textops.slug.underscore') },
  ]);

  const countRows = $derived(
    counts === undefined
      ? []
      : [
          { label: t('textops.count.characters'), value: counts.characters },
          { label: t('textops.count.noSpaces'), value: counts.charactersWithoutSpaces },
          { label: t('textops.count.words'), value: counts.words },
          { label: t('textops.count.lines'), value: counts.lines },
          { label: t('textops.count.paragraphs'), value: counts.paragraphs },
          { label: t('textops.count.bytes'), value: counts.bytes },
        ],
  );
  const formatNumber = $derived(new Intl.NumberFormat(i18n.locale));

  // Not `bind:value`: on a number field Svelte binds a number (or null when it is empty).
  function onStart(event: Event & { currentTarget: HTMLInputElement }): void {
    startText = event.currentTarget.value;
  }

  function useResult(): void {
    text = resultText;
    status = t('textops.moved');
  }
</script>

<ToolFrame id="textops">
  <div class="tool">
    <section class="block">
      <h2 class="heading">{t('textops.text')}</h2>
      <Textarea
        label={t('textops.input')}
        bind:value={text}
        error={textError}
        rows={10}
        spellcheck={false}
      />
      <h3 class="subheading">{t('textops.counts')}</h3>
      <dl class="counts" aria-busy={working}>
        {#each countRows as row (row.label)}
          <div class="count">
            <dt>{row.label}</dt>
            <dd>{formatNumber.format(row.value)}</dd>
          </div>
        {/each}
      </dl>
    </section>

    <section class="block">
      <h2 class="heading">{t('textops.operation')}</h2>
      <Select label={t('textops.do')} options={operationOptions} bind:value={operation} />

      {#if operation === 'case'}
        <Select label={t('textops.caseStyle')} options={caseOptions} bind:value={caseStyle} />
      {:else if operation === 'sort'}
        <Checkbox label={t('textops.sort.descending')} bind:checked={sortDescending} />
        <Checkbox label={t('textops.sort.ignoreCase')} bind:checked={sortIgnoreCase} />
        <Checkbox label={t('textops.sort.numeric')} bind:checked={sortNumeric} />
      {:else if operation === 'dedupe'}
        <Checkbox label={t('textops.dedupe.ignoreCase')} bind:checked={dedupeIgnoreCase} />
        <Checkbox
          label={t('textops.dedupe.ignoreWhitespace')}
          bind:checked={dedupeIgnoreWhitespace}
        />
      {:else if operation === 'trim'}
        <Select label={t('textops.trim.ends')} options={trimOptions} bind:value={trimMode} />
        <Checkbox label={t('textops.trim.removeEmpty')} bind:checked={trimRemoveEmpty} />
        <Checkbox label={t('textops.trim.collapse')} bind:checked={trimCollapse} />
      {:else if operation === 'number'}
        <Input
          type="number"
          inputmode="numeric"
          step={1}
          label={t('textops.number.start')}
          error={startError}
          value={startText}
          oninput={onStart}
        />
        <Input
          label={t('textops.number.separator')}
          error={separatorError}
          bind:value={separator}
          autocomplete="off"
          spellcheck={false}
        />
        <Checkbox label={t('textops.number.pad')} bind:checked={pad} />
      {:else if operation === 'replace'}
        <Input
          keepHint
          label={t('textops.replace.find')}
          hint={regex ? t('textops.replace.findHintRegex') : t('textops.replace.findHint')}
          error={findError}
          bind:value={find}
          autocomplete="off"
          spellcheck={false}
        />
        <Input
          label={t('textops.replace.with')}
          hint={regex ? t('textops.replace.withHintRegex') : ''}
          bind:value={replacement}
          autocomplete="off"
          spellcheck={false}
        />
        <Checkbox label={t('textops.replace.regex')} bind:checked={regex} />
        <Checkbox label={t('textops.replace.ignoreCase')} bind:checked={findIgnoreCase} />
        <Checkbox label={t('textops.replace.wholeWord')} bind:checked={wholeWord} />
      {:else}
        <Select
          label={t('textops.slug.separator')}
          options={slugOptions}
          bind:value={slugSeparator}
        />
        <Checkbox label={t('textops.slug.ascii')} bind:checked={asciiOnly} />
        <Checkbox label={t('textops.slug.umlauts')} bind:checked={germanUmlauts} />
      {/if}
    </section>

    <section class="block" aria-busy={working}>
      <h2 class="heading">{t('textops.result')}</h2>
      <Textarea
        label={t('textops.output')}
        value={resultText}
        readonly
        rows={10}
        spellcheck={false}
      />
      <div class="actions">
        <CopyButton text={resultText} label={t('textops.copy')} value={t('textops.copiedValue')} />
        <DownloadButton
          label={t('textops.download')}
          name="text.txt"
          text={resultText}
          disabled={resultText === ''}
        />
        <Button variant="secondary" size="sm" disabled={resultText === ''} onclick={useResult}>
          {t('textops.use')}
        </Button>
      </div>
      <StatusMessage data-tool-status message={status} />
      <StatusMessage data-tool-status kind="alert" message={failure} />
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

  .heading {
    margin: 0;
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.4px;
  }

  .subheading {
    margin: 0;
    font: 12px var(--mono);
    letter-spacing: 1px;
    color: var(--mut);
    text-transform: uppercase;
    font-weight: 400;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-12);
  }

  .counts {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: var(--space-12);
    margin: 0;
  }

  .count {
    padding: var(--space-8) var(--space-12);
    border: 1px solid var(--line);
  }

  .count dt {
    font: 12px var(--mono);
    color: var(--mut);
  }

  .count dd {
    margin: 0;
    font: 500 18px/1.4 var(--mono);
  }
</style>
