<script lang="ts">
  import type { WorkerPool } from '@stuffcloud/tools';
  import { t } from '../../i18n/index.ts';
  import { saveText } from '../../app/download.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import TextArea from '../../app/TextArea.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import ToolStatus from '../../app/ToolStatus.svelte';
  import Button from '../../ui/Button.svelte';
  import Checkbox from '../../ui/Checkbox.svelte';
  import Input from '../../ui/Input.svelte';
  import Select from '../../ui/Select.svelte';
  import {
    FORMATS,
    MAX_INPUT_CHARS,
    MAX_ROOT_NAME_LENGTH,
    isFormat,
    type Format,
    type Input as TaskInput,
    type Note,
    type Output as TaskOutput,
  } from './convert.ts';
  import { FORMAT_KEYS, convertErrorText } from './messages.ts';
  import { createPool } from './pool.ts';
  import { isXmlName } from './xml.ts';

  /** The page waits this long after the last edit before it converts. */
  const DEBOUNCE_MS = 250;
  /** A conversion that takes longer is stopped (the worker is ended). */
  const TIMEOUT_MS = 10_000;

  type Layout = '2' | '4' | 'tab' | 'min';

  const FILE_TYPES: Readonly<Record<Format, { extension: string; type: string }>> = {
    json: { extension: 'json', type: 'application/json' },
    yaml: { extension: 'yaml', type: 'application/yaml' },
    xml: { extension: 'xml', type: 'application/xml' },
  };

  let from = $state<Format>('json');
  let to = $state<Format>('yaml');
  let text = $state(
    '{"name":"stuffcloud","tags":["json","yaml","xml"],"nested":{"ok":true,"count":3}}',
  );
  let layout = $state<Layout>('2');
  let sortKeys = $state(false);
  let rootName = $state('root');
  let declaration = $state(true);
  let typed = $state(false);
  let result = $state<string | undefined>(undefined);
  let notes = $state<readonly Note[]>([]);
  let status = $state('');
  let failure = $state('');

  let pool: WorkerPool<TaskInput, TaskOutput> | undefined;
  let controller: AbortController | undefined;

  $effect(() => () => {
    controller?.abort();
    pool?.terminate();
  });

  const formatOptions = $derived(
    FORMATS.map((format) => ({ value: format, label: t(FORMAT_KEYS[format]) })),
  );
  const layoutOptions = $derived([
    { value: '2', label: t('convert.indent.2') },
    { value: '4', label: t('convert.indent.4') },
    { value: 'tab', label: t('convert.indent.tab') },
    { value: 'min', label: t('convert.indent.min') },
  ]);

  const tooLong = $derived(text.length > MAX_INPUT_CHARS);
  const rootProblem = $derived(
    to === 'xml' && (rootName.length > MAX_ROOT_NAME_LENGTH || !isXmlName(rootName))
      ? t('convert.rootNameInvalid')
      : '',
  );

  const request = $derived<TaskInput>({
    from,
    to,
    text,
    indent: layout === 'min' ? 0 : layout === 'tab' ? 'tab' : Number(layout) === 4 ? 4 : 2,
    sortKeys,
    rootName: rootProblem === '' ? rootName : 'root',
    typed,
    declaration,
  });

  // Converting waits for a pause in typing, runs in a worker and is stopped when it takes too long.
  $effect(() => {
    if (tooLong) {
      controller?.abort();
      controller = undefined;
      result = undefined;
      notes = [];
      status = '';
      failure = t('convert.error.inputTooLarge', { max: MAX_INPUT_CHARS });
      return;
    }
    const input = request;
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
    const timeoutError = new Error('the conversion took too long');
    const timeout = setTimeout(() => {
      own.abort(timeoutError);
    }, TIMEOUT_MS);
    try {
      const output = await pool.run(input, { signal: own.signal });
      if (controller !== own) {
        return;
      }
      if (output.ok) {
        result = output.text;
        notes = output.notes;
        failure = '';
        status = t('convert.done', {
          from: t(FORMAT_KEYS[input.from]),
          to: t(FORMAT_KEYS[input.to]),
        });
      } else {
        result = undefined;
        notes = [];
        status = '';
        failure = convertErrorText(output.error);
      }
    } catch {
      if (own.signal.reason === timeoutError) {
        result = undefined;
        notes = [];
        status = '';
        failure = t('convert.timeout', { seconds: TIMEOUT_MS / 1000 });
      } else if (controller === own) {
        // Not stopped by a newer edit: the worker itself failed.
        result = undefined;
        notes = [];
        status = '';
        failure = t('convert.failed');
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  function noteText(note: Note): string {
    return t(note.kind === 'bigNumbers' ? 'convert.note.bigNumbers' : 'convert.note.nulls', {
      count: note.count,
    });
  }

  function swap(): void {
    const previous = from;
    from = to;
    to = previous;
    if (result !== undefined) {
      text = result;
    }
  }

  function download(): void {
    if (result !== undefined) {
      const file = FILE_TYPES[to];
      saveText(`converted.${file.extension}`, result, file.type);
    }
  }
</script>

<ToolFrame id="json-yaml-xml">
  <div class="tool">
    <section class="block">
      <div class="pair">
        <Select
          label={t('convert.from')}
          options={formatOptions}
          value={from}
          onchange={(event: Event & { currentTarget: HTMLSelectElement }) => {
            if (isFormat(event.currentTarget.value)) {
              from = event.currentTarget.value;
            }
          }}
        />
        <Select
          label={t('convert.to')}
          options={formatOptions}
          value={to}
          onchange={(event: Event & { currentTarget: HTMLSelectElement }) => {
            if (isFormat(event.currentTarget.value)) {
              to = event.currentTarget.value;
            }
          }}
        />
      </div>
      <div>
        <Button variant="ghost" size="compact" onclick={swap}>{t('convert.swap')}</Button>
      </div>
      <TextArea
        label={t('convert.input')}
        bind:value={text}
        rows={12}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
      />
      <div class="options">
        <Select label={t('convert.indent')} options={layoutOptions} bind:value={layout} />
        <div class="checks">
          <Checkbox label={t('convert.sort')} bind:checked={sortKeys} />
          {#if from === 'xml'}
            <Checkbox label={t('convert.typed')} bind:checked={typed} />
          {/if}
          {#if to === 'xml'}
            <Checkbox label={t('convert.declaration')} bind:checked={declaration} />
          {/if}
        </div>
      </div>
      {#if to === 'xml'}
        <Input
          label={t('convert.rootName')}
          hint={t('convert.rootNameHint')}
          bind:value={rootName}
          error={rootProblem}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
        />
      {/if}
      <ToolStatus message={status} />
      <ToolStatus kind="alert" message={failure} />
      {#if notes.length > 0}
        <ul class="notes">
          {#each notes as note (note.kind)}
            <li>{noteText(note)}</li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if result !== undefined}
      <section class="block">
        <h2 class="heading">{t('convert.result')}</h2>
        <TextArea
          label={t('convert.result')}
          value={result}
          readonly
          rows={12}
          spellcheck={false}
        />
        <div class="row">
          <CopyButton text={result} label={t('convert.copy')} value={t('convert.copied')} />
          <Button variant="ghost" size="compact" onclick={download}>{t('convert.download')}</Button>
        </div>
      </section>
    {/if}

    {#if from === 'xml' || to === 'xml'}
      <p class="note">{t('convert.note.xml')}</p>
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

  .pair,
  .options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: var(--space-16);
    align-items: start;
  }

  .checks {
    display: flex;
    flex-direction: column;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-12);
  }

  .notes {
    margin: 0;
    padding-left: var(--space-20);
    font: 14px/1.5 var(--mono);
    color: var(--mut);
  }

  .note {
    margin: 0;
    max-width: 760px;
    font: 13px/1.5 var(--mono);
    color: var(--mut);
  }
</style>
