<script lang="ts">
  import { FileDrop, Progress } from '@mozra-the-great/kern';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import { i18n, t } from '../../i18n/index.ts';
  import { buildFiles } from '../../pdf/client.ts';
  import { release, toResult, type ResultFile } from '../../pdf/download.ts';
  import { formatBytes } from '../../pdf/format.ts';
  import { failureText, isAbort, issueText } from '../../pdf/issues.ts';
  import LiveStatus from '../../pdf/LiveStatus.svelte';
  import { baseName } from '../../pdf/names.ts';
  import { initialPages } from '../../pdf/page-edit.ts';
  import PageGrid from '../../pdf/PageGrid.svelte';
  import { SingleDocument } from '../../pdf/session.svelte.ts';
  import { planSplit, type SplitMode } from '../../pdf/split-plan.ts';
  import { buildZip, ZipLimitError } from '../../pdf/zip.ts';
  import Button from '../../ui/Button.svelte';
  import Input from '../../ui/Input.svelte';
  import LinkButton from '../../ui/LinkButton.svelte';
  import Select from '../../ui/Select.svelte';

  const doc = new SingleDocument();

  let controller: AbortController | undefined;
  let mode = $state<SplitMode>('ranges');
  let rangesText = $state('');
  let everyText = $state('2');
  let selected: ReadonlySet<number> = $state.raw(new Set());
  let working = $state(false);
  let completed = $state(0);
  let total = $state(1);
  let results: ResultFile[] = $state([]);
  let zip: { url: string; name: string; size: number } | undefined = $state();
  let status = $state('');
  let error = $state('');

  const plan = $derived(
    planSplit({
      mode,
      fileName: doc.file?.name ?? '',
      pageCount: doc.pageCount,
      rangesText,
      everyText,
      selected,
    }),
  );
  const message = $derived(plan.ok ? '' : plan.message);
  const pages = $derived(initialPages(doc.pageCount));
  const modeOptions = $derived([
    { value: 'ranges', label: t('pdf.split.mode.ranges') },
    { value: 'every', label: t('pdf.split.mode.every') },
    { value: 'selection', label: t('pdf.split.mode.selection') },
  ]);

  $effect(() => () => {
    controller?.abort();
    forgetResults();
    doc.dispose();
  });

  // The pictures are only needed to choose pages.
  $effect(() => {
    if (mode === 'selection' && doc.state === 'ready') {
      doc.startThumbs();
    }
  });

  function forgetResults(): void {
    release(results);
    results = [];
    if (zip !== undefined) {
      URL.revokeObjectURL(zip.url);
      zip = undefined;
    }
  }

  async function onfiles(files: File[]): Promise<void> {
    // The drop zone of this tool takes one file; if it ever gave more, the first one is used.
    for (const file of files.slice(0, 1)) {
      forgetResults();
      selected = new Set();
      error = '';
      status = t('pdf.split.reading', { name: file.name });
      const ok = await doc.open(file);
      if (ok) {
        status = t('pdf.split.opened', { name: file.name, count: doc.pageCount });
      } else if (doc.crashed) {
        status = '';
        error = failureText();
      } else if (doc.issue !== undefined) {
        status = '';
        error = issueText(doc.issue, file.name);
      }
    }
  }

  function onreject(files: File[]): void {
    error = t('pdf.drop.notPdf', { count: files.length });
  }

  async function split(): Promise<void> {
    const source = doc.file;
    if (!plan.ok || source === undefined) {
      return;
    }
    forgetResults();
    error = '';
    status = t('pdf.split.working');
    working = true;
    completed = 0;
    total = plan.outputs.length * 2;
    controller = new AbortController();
    const { signal } = controller;
    try {
      const output = await buildFiles(doc.ops, [source], plan.outputs, {
        signal,
        onProgress: (done, steps) => {
          completed = done;
          total = steps;
        },
      });
      if (!output.ok) {
        status = '';
        error = issueText(output.issue, source.name);
        return;
      }
      results = output.files.map(toResult);
      if (results.length > 1) {
        try {
          const archive = buildZip(
            results.map((file) => ({
              name: file.name,
              data: file.blob,
              size: file.size,
              crc32: file.crc32,
            })),
          );
          zip = {
            url: URL.createObjectURL(archive),
            name: `${baseName(source.name)}_split.zip`,
            size: archive.size,
          };
        } catch (failure: unknown) {
          if (!(failure instanceof ZipLimitError)) {
            throw failure;
          }
        }
      }
      status = t('pdf.split.done', { count: results.length });
    } catch (failure: unknown) {
      if (isAbort(failure) || signal.aborted) {
        status = t('pdf.split.cancelled');
      } else {
        status = '';
        error = failureText();
      }
    } finally {
      working = false;
    }
  }

  function cancel(): void {
    controller?.abort();
  }
</script>

<ToolFrame id="pdf-split">
  <FileDrop
    mode="dispatch"
    rejectMessages={false}
    statusLabel=""
    dropLabel={t('pdf.drop.one')}
    buttonLabel={t('pdf.drop.oneButton')}
    accept=".pdf,application/pdf"
    multiple={false}
    disabled={working}
    onfiles={(files: File[]) => void onfiles(files)}
    {onreject}
  />

  {#if doc.state === 'ready' && doc.file !== undefined}
    <p class="file">
      <strong>{doc.file.name}</strong>
      <span class="meta"
        >{t('pdf.file.meta', {
          count: doc.pageCount,
          size: formatBytes(doc.file.size, i18n.locale),
        })}</span
      >
    </p>

    <div class="options">
      <Select label={t('pdf.split.mode')} options={modeOptions} bind:value={mode} />
      {#if mode === 'ranges'}
        <Input
          label={t('pdf.split.rangesLabel')}
          hint={t('pdf.split.rangesHint')}
          error={rangesText.trim() === '' ? '' : message}
          bind:value={rangesText}
          autocomplete="off"
          spellcheck={false}
        />
      {:else if mode === 'every'}
        <Input
          label={t('pdf.split.everyLabel')}
          hint={t('pdf.split.everyHint')}
          error={everyText.trim() === '' ? '' : message}
          bind:value={everyText}
          inputmode="numeric"
          autocomplete="off"
        />
      {:else}
        <p class="hint">{t('pdf.split.selectHint')}</p>
        <p class="hint">{t('pdf.pages.keys')}</p>
        <PageGrid
          {pages}
          {selected}
          store={doc.thumbs}
          label={t('pdf.split.grid', { name: doc.file.name })}
          pageLabel={(_page: { id: number; turn: number }, position: number) =>
            t('pdf.split.pageLabel', { page: position })}
          onselect={(next: Set<number>) => {
            selected = next;
          }}
        />
        <p class="hint">{t('pdf.split.selected', { count: selected.size })}</p>
      {/if}
    </div>

    {#if plan.ok}
      <p class="hint">{t('pdf.split.preview', { count: plan.outputs.length })}</p>
    {/if}

    <div class="actions">
      <Button disabled={!plan.ok || working} onclick={() => void split()}
        >{t('pdf.split.start')}</Button
      >
      <Button variant="ghost" disabled={!working} onclick={cancel}>{t('pdf.action.cancel')}</Button>
    </div>
  {/if}

  {#if working}
    <Progress
      hideLabel
      label={t('pdf.progress')}
      value={completed}
      max={total}
      valueText={t('pdf.progress.steps', { completed, total })}
    />
  {/if}

  <LiveStatus {status} {error} />

  {#if results.length > 0}
    <section class="results" aria-labelledby="split-results">
      <h2 id="split-results" class="sub">{t('pdf.split.results')}</h2>
      {#if zip !== undefined}
        <div>
          <LinkButton href={zip.url} download={zip.name}
            >{t('pdf.split.zip', { size: formatBytes(zip.size, i18n.locale) })}</LinkButton
          >
        </div>
      {/if}
      <ul class="files" aria-labelledby="split-results">
        {#each results as file (file.url)}
          <li>
            <span class="file-name">{file.name}</span>
            <span class="meta"
              >{t('pdf.file.meta', {
                count: file.pageCount,
                size: formatBytes(file.size, i18n.locale),
              })}</span
            >
            <LinkButton
              variant="ghost"
              size="compact"
              href={file.url}
              download={file.name}
              aria-label={t('pdf.split.downloadFile', { name: file.name })}
              >{t('pdf.action.download')}</LinkButton
            >
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</ToolFrame>

<style>
  .file {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-12);
    align-items: baseline;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .meta {
    font: 13px var(--mono);
    color: var(--mut);
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: var(--space-16);
    max-width: 40rem;
  }

  .hint {
    margin: 0;
    color: var(--mut);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-12);
  }

  .results {
    display: flex;
    flex-direction: column;
    gap: var(--space-12);
  }

  .sub {
    margin: 0;
    font-size: 20px;
    font-weight: 500;
  }

  .files {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .files li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-12);
    padding: var(--space-8) var(--space-12);
    border: 1px solid var(--line2);
  }

  .file-name {
    flex: 1 1 12rem;
    overflow-wrap: anywhere;
  }
</style>
