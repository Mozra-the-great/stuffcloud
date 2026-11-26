<script lang="ts">
  import { Button } from '@mozra-the-great/kern';
  import { t } from '../../i18n/index.ts';
  import { saveText } from '../../app/download.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import TextArea from '../../app/TextArea.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import ToolStatus from '../../app/ToolStatus.svelte';
  import Checkbox from '../../ui/Checkbox.svelte';
  import Input from '../../ui/Input.svelte';
  import Select from '../../ui/Select.svelte';
  import {
    formatJson,
    formatPath,
    parseJson,
    parsePath,
    pathAt,
    statsOf,
    valueAt,
    type FormatOptions,
  } from './json.ts';
  import { featureList, jsonErrorText } from './messages.ts';

  /** The longest text the page formats; the reader runs on the page, so this keeps typing smooth. */
  const MAX_CHARS = 2_000_000;
  const STATUS_DELAY_MS = 400;

  type Layout = '2' | '4' | 'tab' | 'min';

  let text = $state(
    '{"name":"stuffcloud","tags":["json","yaml","xml"],"nested":{"ok":true,"count":3}}',
  );
  let layout = $state<Layout>('2');
  let sortKeys = $state(false);
  let strict = $state(false);
  let cursor = $state(0);
  let pathQuery = $state('');
  let status = $state('');
  let failure = $state('');
  let inputBox: HTMLElement | undefined = $state();

  const layoutOptions = $derived([
    { value: '2', label: t('json.indent.2') },
    { value: '4', label: t('json.indent.4') },
    { value: 'tab', label: t('json.indent.tab') },
    { value: 'min', label: t('json.indent.min') },
  ]);

  const tooLong = $derived(text.length > MAX_CHARS);
  const parsed = $derived(tooLong ? undefined : parseJson(text, { strict }));
  const tree = $derived(parsed?.ok === true ? parsed.node : undefined);
  const stats = $derived(tree === undefined ? undefined : statsOf(tree));

  const formatOptions = $derived<FormatOptions>({
    indent: layout === 'min' ? 0 : layout === 'tab' ? 'tab' : Number(layout),
    sortKeys,
  });
  const output = $derived(tree === undefined ? undefined : formatJson(tree, formatOptions));

  const problem = $derived.by((): string => {
    if (tooLong) {
      return t('json.tooLong', { max: MAX_CHARS });
    }
    return parsed?.ok === false ? jsonErrorText(parsed.error) : '';
  });

  const summary = $derived.by((): string => {
    if (parsed?.ok !== true || stats === undefined) {
      return '';
    }
    if (parsed.features.length > 0) {
      return t('json.validLoose', { features: featureList(parsed.features) });
    }
    const values =
      stats.objects + stats.arrays + stats.strings + stats.numbers + stats.booleans + stats.nulls;
    return t('json.valid', { count: values, depth: stats.depth });
  });

  // What is said waits for a pause in typing, so that a screen reader is not told about every key.
  $effect(() => {
    const message = problem === '' ? summary : '';
    const alert = problem;
    const timer = setTimeout(() => {
      status = message;
      failure = alert;
    }, STATUS_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  });

  const cursorPath = $derived(tree === undefined ? '' : formatPath(pathAt(tree, cursor)));

  const found = $derived.by(() => {
    if (tree === undefined || pathQuery.trim() === '') {
      return undefined;
    }
    const path = parsePath(pathQuery);
    if (!path.ok) {
      return { error: t('json.pathInvalid', { position: path.offset + 1 }) } as const;
    }
    const node = valueAt(tree, path.segments);
    return node === undefined
      ? ({ none: true } as const)
      : ({ text: formatJson(node, { indent: 2, sortKeys: false }) } as const);
  });

  function trackCursor(event: Event & { currentTarget: HTMLTextAreaElement }): void {
    cursor = event.currentTarget.selectionStart;
  }

  function goToError(): void {
    const area = inputBox?.querySelector('textarea');
    if (area !== null && area !== undefined && parsed?.ok === false) {
      area.focus();
      area.setSelectionRange(parsed.error.offset, parsed.error.offset);
    }
  }

  function useAsInput(): void {
    if (output !== undefined) {
      text = output;
    }
  }
</script>

<ToolFrame id="json-formatter">
  <div class="tool">
    <section class="block">
      <div class="field" bind:this={inputBox}>
        <TextArea
          label={t('json.input')}
          bind:value={text}
          rows={12}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          onkeyup={trackCursor}
          onclick={trackCursor}
          onselect={trackCursor}
        />
      </div>
      <div class="options">
        <Select label={t('json.indent')} options={layoutOptions} bind:value={layout} />
        <div class="checks">
          <Checkbox label={t('json.sort')} bind:checked={sortKeys} />
          <Checkbox label={t('json.strict')} bind:checked={strict} />
        </div>
      </div>
      <ToolStatus message={status} />
      <ToolStatus kind="alert" message={failure} />
      {#if parsed?.ok === false}
        <div>
          <Button variant="secondary" size="sm" onclick={goToError}>{t('json.goToError')}</Button>
        </div>
      {/if}
      {#if stats !== undefined && (stats.duplicateKeys > 0 || stats.bigNumbers > 0)}
        <ul class="notes">
          {#if stats.duplicateKeys > 0}
            <li>{t('json.warn.duplicates', { count: stats.duplicateKeys })}</li>
          {/if}
          {#if stats.bigNumbers > 0}
            <li>{t('json.warn.bigNumbers', { count: stats.bigNumbers })}</li>
          {/if}
        </ul>
      {/if}
      {#if tree !== undefined}
        <p class="path">{t('json.pathAtCursor', { path: cursorPath })}</p>
      {/if}
    </section>

    {#if output !== undefined}
      <section class="block">
        <h2 class="heading">{t('json.result')}</h2>
        <TextArea label={t('json.result')} value={output} readonly rows={12} spellcheck={false} />
        <div class="row">
          <CopyButton text={output} label={t('json.copy')} value={t('json.copied')} />
          <Button
            variant="secondary"
            size="sm"
            onclick={() => {
              saveText('formatted.json', output, 'application/json');
            }}>{t('json.download')}</Button
          >
          <Button variant="secondary" size="sm" onclick={useAsInput}>{t('json.useAsInput')}</Button>
        </div>
      </section>

      <section class="block">
        <h2 class="heading">{t('json.pathFind')}</h2>
        <Input
          label={t('json.pathFind')}
          hint={t('json.pathFindHint')}
          bind:value={pathQuery}
          error={found !== undefined && 'error' in found ? found.error : ''}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
        />
        {#if found !== undefined && 'none' in found}
          <p class="path">{t('json.pathNone')}</p>
        {:else if found !== undefined && 'text' in found}
          <TextArea
            label={t('json.pathValue')}
            value={found.text}
            readonly
            rows={5}
            spellcheck={false}
          />
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

  .path {
    margin: 0;
    font: 14px/1.5 var(--mono);
    color: var(--mut);
    overflow-wrap: anywhere;
  }
</style>
