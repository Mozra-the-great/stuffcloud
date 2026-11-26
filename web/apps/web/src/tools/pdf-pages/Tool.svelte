<script lang="ts">
  import { FileDrop, Progress } from '@mozra-the-great/kern';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import { i18n, t } from '../../i18n/index.ts';
  import { buildFiles } from '../../pdf/client.ts';
  import { release, toResult, type ResultFile } from '../../pdf/download.ts';
  import { formatBytes } from '../../pdf/format.ts';
  import {
    canRedo,
    canUndo,
    commit,
    redo,
    startHistory,
    undo,
    type History,
  } from '../../pdf/history.ts';
  import { failureText, isAbort, issueText } from '../../pdf/issues.ts';
  import LiveStatus from '../../pdf/LiveStatus.svelte';
  import { baseName } from '../../pdf/names.ts';
  import {
    describeAction,
    pageName,
    parsePosition,
    type ActionLabel,
  } from '../../pdf/page-actions.ts';
  import {
    initialPages,
    isChanged,
    moveIndex,
    moveTo,
    remove,
    rotate,
    shift,
    toOutput,
    type Pages,
  } from '../../pdf/page-edit.ts';
  import PageGrid from '../../pdf/PageGrid.svelte';
  import { SingleDocument } from '../../pdf/session.svelte.ts';
  import Button from '../../ui/Button.svelte';
  import Input from '../../ui/Input.svelte';
  import LinkButton from '../../ui/LinkButton.svelte';

  const doc = new SingleDocument();
  const START: ActionLabel = { key: 'pdf.pages.did.start', count: 0 };

  let controller: AbortController | undefined;
  let history: History<Pages, ActionLabel> = $state.raw(startHistory(initialPages(0), START));
  let selected: ReadonlySet<number> = $state.raw(new Set());
  let position = $state('');
  let positionError = $state('');
  let working = $state(false);
  let completed = $state(0);
  let total = $state(1);
  let result: ResultFile | undefined = $state();
  let status = $state('');
  let error = $state('');

  const pages = $derived(history.present.value);
  const hasSelection = $derived(selected.size > 0);

  $effect(() => () => {
    controller?.abort();
    forgetResult();
    doc.dispose();
  });

  function forgetResult(): void {
    if (result !== undefined) {
      release([result]);
      result = undefined;
    }
  }

  async function onfiles(files: File[]): Promise<void> {
    // The drop zone of this tool takes one file; if it ever gave more, the first one is used.
    for (const file of files.slice(0, 1)) {
      forgetResult();
      selected = new Set();
      positionError = '';
      error = '';
      status = t('pdf.split.reading', { name: file.name });
      const ok = await doc.open(file);
      if (ok) {
        history = startHistory(initialPages(doc.pageCount), START);
        doc.startThumbs();
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

  /** Makes `next` the document and says what happened. */
  function apply(next: Pages, label: ActionLabel): void {
    history = commit(history, next, label);
    forgetResult();
    error = '';
    positionError = '';
    status = describeAction(label);
  }

  /** Runs `action` on the selected pages, or says that none are selected. */
  function onSelection(action: (ids: ReadonlySet<number>) => void): void {
    if (!hasSelection) {
      status = '';
      error = t('pdf.pages.needSelection');
      return;
    }
    action(selected);
  }

  function turn(degrees: number): void {
    onSelection((ids) => {
      apply(rotate(pages, ids, degrees), {
        key: degrees > 0 ? 'pdf.pages.did.right' : 'pdf.pages.did.left',
        count: ids.size,
      });
    });
  }

  function removeSelected(): void {
    onSelection((ids) => {
      apply(remove(pages, ids), { key: 'pdf.pages.did.deleted', count: ids.size });
      selected = new Set();
    });
  }

  function shiftSelected(direction: -1 | 1): void {
    onSelection((ids) => {
      apply(shift(pages, ids, direction), {
        key: direction === -1 ? 'pdf.pages.did.earlier' : 'pdf.pages.did.later',
        count: ids.size,
      });
    });
  }

  function moveSelectedTo(target: number, key: ActionLabel['key']): void {
    onSelection((ids) => {
      apply(moveTo(pages, ids, target), { key, count: ids.size, position: target });
    });
  }

  function submitPosition(event: SubmitEvent): void {
    event.preventDefault();
    const target = parsePosition(position, pages.length);
    if (target === undefined) {
      positionError = t('pdf.pages.positionError', { max: pages.length });
      return;
    }
    moveSelectedTo(target, 'pdf.pages.did.movedTo');
  }

  function onmove(from: number, to: number): void {
    apply(moveIndex(pages, from, to), {
      key: 'pdf.pages.did.movedTo',
      count: 1,
      position: to + 1,
    });
  }

  /** Selection only keeps pages that still exist after undo or redo. */
  function keepExisting(next: Pages): void {
    const ids = new Set(next.map((page) => page.id));
    selected = new Set([...selected].filter((id) => ids.has(id)));
  }

  function undoStep(): void {
    if (!canUndo(history)) {
      status = t('pdf.pages.nothingToUndo');
      return;
    }
    const undone = describeAction(history.present.label);
    history = undo(history);
    keepExisting(history.present.value);
    forgetResult();
    status = t('pdf.pages.undone', { action: undone });
  }

  function redoStep(): void {
    const next = history.future[0];
    if (next === undefined) {
      status = t('pdf.pages.nothingToRedo');
      return;
    }
    history = redo(history);
    keepExisting(history.present.value);
    forgetResult();
    status = t('pdf.pages.redone', { action: describeAction(next.label) });
  }

  function onkeydown(event: KeyboardEvent): void {
    const target = event.target;
    if (
      !(event.ctrlKey || event.metaKey) ||
      (target instanceof HTMLElement && target.closest('input, textarea') !== null)
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undoStep();
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      redoStep();
    }
  }

  async function save(): Promise<void> {
    const source = doc.file;
    if (source === undefined || pages.length === 0) {
      return;
    }
    forgetResult();
    error = '';
    status = t('pdf.pages.saving');
    working = true;
    completed = 0;
    total = 2;
    controller = new AbortController();
    const { signal } = controller;
    try {
      const output = await buildFiles(
        doc.ops,
        [source],
        [toOutput(`${baseName(source.name)}_edited.pdf`, pages)],
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
        status = t('pdf.pages.saved', {
          pages: file.pageCount,
          size: formatBytes(result.size, i18n.locale),
        });
      } else if (!output.ok) {
        status = '';
        error = issueText(output.issue, source.name);
      }
    } catch (failure: unknown) {
      if (isAbort(failure) || signal.aborted) {
        status = t('pdf.pages.cancelled');
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

<ToolFrame id="pdf-pages">
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

  <!-- Ctrl+Z / Ctrl+Y work anywhere in the editor except inside a text field. -->
  <div class="editor" role="presentation" {onkeydown}>
    {#if doc.state === 'ready' && doc.file !== undefined}
      <p class="file">
        <strong>{doc.file.name}</strong>
        <span class="meta"
          >{t('pdf.pages.summary', { count: pages.length, total: doc.pageCount })}</span
        >
      </p>

      <p class="hint">{t('pdf.pages.keys')}</p>

      <div class="toolbar" role="group" aria-label={t('pdf.pages.actions')}>
        <div class="cluster" role="group" aria-label={t('pdf.pages.group.select')}>
          <Button
            variant="ghost"
            size="compact"
            onclick={() => {
              selected = new Set(pages.map((page) => page.id));
              status = t('pdf.split.selected', { count: selected.size });
            }}>{t('pdf.pages.selectAll')}</Button
          >
          <Button
            variant="ghost"
            size="compact"
            onclick={() => {
              selected = new Set();
              status = t('pdf.split.selected', { count: 0 });
            }}>{t('pdf.pages.selectNone')}</Button
          >
        </div>
        <div class="cluster" role="group" aria-label={t('pdf.pages.group.turn')}>
          <Button
            variant="ghost"
            size="compact"
            aria-disabled={!hasSelection}
            onclick={() => {
              turn(-90);
            }}>{t('pdf.pages.turnLeft')}</Button
          >
          <Button
            variant="ghost"
            size="compact"
            aria-disabled={!hasSelection}
            onclick={() => {
              turn(90);
            }}>{t('pdf.pages.turnRight')}</Button
          >
          <Button
            variant="ghost"
            size="compact"
            aria-disabled={!hasSelection}
            onclick={removeSelected}>{t('pdf.pages.delete')}</Button
          >
        </div>
        <div class="cluster" role="group" aria-label={t('pdf.pages.group.move')}>
          <Button
            variant="ghost"
            size="compact"
            aria-disabled={!hasSelection}
            onclick={() => {
              shiftSelected(-1);
            }}>{t('pdf.pages.earlier')}</Button
          >
          <Button
            variant="ghost"
            size="compact"
            aria-disabled={!hasSelection}
            onclick={() => {
              shiftSelected(1);
            }}>{t('pdf.pages.later')}</Button
          >
          <Button
            variant="ghost"
            size="compact"
            aria-disabled={!hasSelection}
            onclick={() => {
              moveSelectedTo(1, 'pdf.pages.did.toStart');
            }}>{t('pdf.pages.toStart')}</Button
          >
          <Button
            variant="ghost"
            size="compact"
            aria-disabled={!hasSelection}
            onclick={() => {
              moveSelectedTo(pages.length, 'pdf.pages.did.toEnd');
            }}>{t('pdf.pages.toEnd')}</Button
          >
        </div>
        <form class="cluster position" onsubmit={submitPosition}>
          <Input
            label={t('pdf.pages.position')}
            bind:value={position}
            error={positionError}
            inputmode="numeric"
            autocomplete="off"
          />
          <Button variant="ghost" size="compact" type="submit" aria-disabled={!hasSelection}
            >{t('pdf.pages.moveHere')}</Button
          >
        </form>
        <div class="cluster" role="group" aria-label={t('pdf.pages.group.history')}>
          <Button
            variant="ghost"
            size="compact"
            aria-disabled={!canUndo(history)}
            onclick={undoStep}>{t('pdf.pages.undo')}</Button
          >
          <Button
            variant="ghost"
            size="compact"
            aria-disabled={!canRedo(history)}
            onclick={redoStep}>{t('pdf.pages.redo')}</Button
          >
        </div>
      </div>

      {#if pages.length === 0}
        <p class="hint">{t('pdf.pages.none')}</p>
      {/if}

      <PageGrid
        {pages}
        {selected}
        store={doc.thumbs}
        label={t('pdf.split.grid', { name: doc.file.name })}
        pageLabel={pageName}
        onselect={(next: Set<number>) => {
          selected = next;
        }}
        {onmove}
      />
      <p class="hint">{t('pdf.split.selected', { count: selected.size })}</p>
      {#if doc.thumbs?.failed === true}
        <p class="hint">{t('pdf.thumbs.failed')}</p>
      {/if}

      <div class="actions">
        <Button disabled={working || pages.length === 0} onclick={() => void save()}
          >{t('pdf.pages.save')}</Button
        >
        <Button variant="ghost" disabled={!working} onclick={cancel}
          >{t('pdf.action.cancel')}</Button
        >
      </div>
      {#if !isChanged(pages, doc.pageCount) && result === undefined}
        <p class="hint">{t('pdf.pages.unchanged')}</p>
      {/if}
    {/if}
  </div>

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
    <div class="actions">
      <LinkButton href={result.url} download={result.name}
        >{t('pdf.action.download')} {result.name}</LinkButton
      >
    </div>
  {/if}
</ToolFrame>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-16);
  }

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

  .hint {
    margin: 0;
    color: var(--mut);
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-16) var(--space-24);
  }

  .cluster {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-8);
  }

  .position {
    margin: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-12);
  }

  /* A button that does nothing yet stays focusable (the focus is not lost when it just ran), so it is dimmed, not disabled. */
  .toolbar :global(.sc-btn[aria-disabled='true']) {
    opacity: 0.4;
    cursor: not-allowed;
  }

  @media (forced-colors: active) {
    .toolbar :global(.sc-btn[aria-disabled='true']) {
      opacity: 1;
      border-color: GrayText;
      color: GrayText;
    }
  }
</style>
