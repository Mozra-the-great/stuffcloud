<script lang="ts">
  import { Button, FileDrop, Progress } from '@mozra-the-great/kern';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import ReorderList from '../../app/ReorderList.svelte';
  import { i18n, t } from '../../i18n/index.ts';
  import { buildFiles, inspectFile } from '../../pdf/client.ts';
  import { release, toResult, type ResultFile } from '../../pdf/download.ts';
  import { formatBytes } from '../../pdf/format.ts';
  import { failureText, isAbort, issueText } from '../../pdf/issues.ts';
  import { fitsInputLimit, MAX_MERGE_FILES, MAX_TOTAL_INPUT_BYTES } from '../../pdf/limits.ts';
  import LiveStatus from '../../pdf/LiveStatus.svelte';
  import { createOpsRunner } from '../../pdf/runners.ts';
  import type { PdfInput, PdfIssue, PdfOutput, PdfRunner } from '../../pdf/types.ts';

  interface Entry {
    /** Stays with the file while it moves in the list. */
    readonly key: number;
    readonly file: File;
    readonly state: 'reading' | 'ready' | 'failed';
    readonly pageCount: number;
    readonly issue: PdfIssue | undefined;
  }

  let runner: PdfRunner<PdfInput, PdfOutput> | undefined;
  let controller: AbortController | undefined;
  let nextKey = 0;

  let entries: Entry[] = $state([]);
  let working = $state(false);
  let completed = $state(0);
  let total = $state(1);
  let result: ResultFile | undefined = $state();
  let status = $state('');
  let error = $state('');

  const readyCount = $derived(entries.filter((entry) => entry.state === 'ready').length);
  const reading = $derived(entries.some((entry) => entry.state === 'reading'));
  const canMerge = $derived(readyCount >= 2 && !reading && !working);

  $effect(() => () => {
    controller?.abort();
    runner?.terminate();
    if (result !== undefined) {
      release([result]);
    }
  });

  function ops(): PdfRunner<PdfInput, PdfOutput> {
    runner ??= createOpsRunner();
    return runner;
  }

  function forgetResult(): void {
    if (result !== undefined) {
      release([result]);
      result = undefined;
    }
  }

  function update(key: number, patch: Partial<Entry>): void {
    entries = entries.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry));
  }

  async function read(entry: Entry): Promise<void> {
    try {
      const output = await inspectFile(ops(), entry.file);
      if (output.ok) {
        update(entry.key, { state: 'ready', pageCount: output.pageCount });
      } else {
        update(entry.key, { state: 'failed', issue: output.issue });
      }
    } catch {
      update(entry.key, { state: 'failed', issue: 'broken' });
    }
  }

  function onfiles(files: File[]): void {
    forgetResult();
    status = '';
    error = '';
    const room = MAX_MERGE_FILES - entries.length;
    let bytes = entries.reduce((sum, entry) => sum + entry.file.size, 0);
    const added: Entry[] = [];
    let refused = 0;
    for (const file of files) {
      if (added.length >= room || !fitsInputLimit(bytes + file.size)) {
        refused += 1;
        continue;
      }
      bytes += file.size;
      added.push({ key: nextKey, file, state: 'reading', pageCount: 0, issue: undefined });
      nextKey += 1;
    }
    entries = [...entries, ...added];
    for (const entry of added) {
      void read(entry);
    }
    if (refused > 0) {
      error = t('pdf.merge.refused', {
        max: MAX_MERGE_FILES,
        size: formatBytes(MAX_TOTAL_INPUT_BYTES, i18n.locale),
      });
    } else if (added.length > 0) {
      status = t('pdf.merge.added', { count: added.length });
    }
  }

  function onreject(files: File[]): void {
    error = t('pdf.drop.notPdf', { count: files.length });
  }

  function move(from: number, to: number): void {
    const moving = entries[from];
    if (moving === undefined || to < 0 || to >= entries.length) {
      return;
    }
    const next = [...entries];
    next.splice(from, 1);
    next.splice(to, 0, moving);
    entries = next;
    forgetResult();
    status = t('pdf.merge.moved', {
      name: moving.file.name,
      position: to + 1,
      total: entries.length,
    });
  }

  function remove(index: number): void {
    const gone = entries[index];
    if (gone === undefined) {
      return;
    }
    entries = entries.filter((_, at) => at !== index);
    forgetResult();
    error = '';
    status = t('pdf.merge.removed', { name: gone.file.name });
  }

  function clear(): void {
    entries = [];
    forgetResult();
    error = '';
    status = t('pdf.merge.cleared');
  }

  async function merge(): Promise<void> {
    const ready = entries.filter((entry) => entry.state === 'ready');
    forgetResult();
    error = '';
    status = t('pdf.merge.working');
    working = true;
    completed = 0;
    total = ready.length + 1;
    controller = new AbortController();
    const { signal } = controller;
    try {
      const output = await buildFiles(
        ops(),
        ready.map((entry) => entry.file),
        [
          {
            name: 'merged.pdf',
            parts: ready.map((entry, source) => ({
              source,
              pages: Array.from({ length: entry.pageCount }, (_, index) => ({ index, turn: 0 })),
            })),
          },
        ],
        {
          signal,
          onProgress: (done, steps) => {
            completed = done;
            total = steps;
          },
        },
      );
      const [file] = output.ok ? output.files : [];
      if (file !== undefined) {
        result = toResult(file);
        status = t('pdf.merge.done', {
          files: ready.length,
          pages: file.pageCount,
          size: formatBytes(result.size, i18n.locale),
        });
      } else if (!output.ok) {
        const culprit = output.source === undefined ? undefined : ready[output.source];
        status = '';
        error = issueText(output.issue, culprit?.file.name ?? t('pdf.issue.theFiles'));
      }
    } catch (failure: unknown) {
      if (isAbort(failure) || signal.aborted) {
        status = t('pdf.merge.cancelled');
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

  function metaOf(entry: Entry): string {
    return t('pdf.file.meta', {
      count: entry.pageCount,
      size: formatBytes(entry.file.size, i18n.locale),
    });
  }
</script>

<ToolFrame id="pdf-merge">
  <FileDrop
    mode="dispatch"
    multiple
    rejectMessages={false}
    statusLabel=""
    dropLabel={t('pdf.drop.many')}
    buttonLabel={t('pdf.drop.manyButton')}
    accept=".pdf,application/pdf"
    disabled={working}
    {onfiles}
    {onreject}
  />

  {#if entries.length > 0}
    <ReorderList
      items={entries}
      keyOf={(entry: Entry) => entry.key}
      label={t('pdf.merge.list')}
      texts={{
        up: t('pdf.move.up'),
        down: t('pdf.move.down'),
        remove: t('pdf.remove'),
        upLabel: (entry: Entry) => t('pdf.merge.upLabel', { name: entry.file.name }),
        downLabel: (entry: Entry) => t('pdf.merge.downLabel', { name: entry.file.name }),
        removeLabel: (entry: Entry) => t('pdf.merge.removeLabel', { name: entry.file.name }),
      }}
      onmove={move}
      onremove={remove}
    >
      {#snippet row(entry: Entry)}
        <strong class="name">{entry.file.name}</strong>
        <span class="meta">
          {#if entry.state === 'reading'}
            {t('pdf.merge.reading')}
          {:else if entry.state === 'failed' && entry.issue !== undefined}
            {issueText(entry.issue, entry.file.name)}
          {:else}
            {metaOf(entry)}
          {/if}
        </span>
      {/snippet}
    </ReorderList>
  {/if}

  <div class="actions">
    <Button disabled={!canMerge} onclick={() => void merge()}>{t('pdf.merge.start')}</Button>
    <Button variant="secondary" disabled={!working} onclick={cancel}
      >{t('pdf.action.cancel')}</Button
    >
    <Button variant="secondary" disabled={entries.length === 0 || working} onclick={clear}
      >{t('pdf.merge.clear')}</Button
    >
  </div>
  {#if readyCount < 2 && !working && result === undefined}
    <p class="hint">{t('pdf.merge.needTwo')}</p>
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

  {#if result !== undefined}
    <div class="result">
      <Button href={result.url} download={result.name}
        >{t('pdf.action.download')} {result.name}</Button
      >
    </div>
  {/if}
</ToolFrame>

<style>
  .name {
    display: block;
  }

  .meta {
    display: block;
    font: 13px var(--mono);
    color: var(--mut);
  }

  .actions,
  .result {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-12);
  }

  .hint {
    margin: 0;
    color: var(--mut);
  }
</style>
