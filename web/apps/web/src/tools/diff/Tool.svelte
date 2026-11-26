<script lang="ts">
  import { Select, Checkbox, Textarea, VisuallyHidden, StatusMessage } from '@mozra-the-great/kern';
  import type { WorkerPool } from '@stuffcloud/tools';
  import { t } from '../../i18n/index.ts';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import { createPool } from './pool.ts';
  import {
    DEFAULT_CONTEXT,
    DIFF_TIMEOUT_MS,
    MAX_ROWS,
    MAX_TEXT_LENGTH,
    leftSide,
    rightSide,
    type DiffUnit,
    type Input as TaskInput,
    type Output as TaskOutput,
    type Segment,
  } from './task.ts';

  /** Typing waits this long for a pause before the texts are compared. */
  const DEBOUNCE_MS = 300;

  type View = 'side-by-side' | 'inline';

  let before = $state('The quick brown fox\njumps over\nthe lazy dog.\n');
  let after = $state('The quick red fox\njumps over\nthe lazy dog.\nGood dog!\n');
  let unit = $state<DiffUnit>('lines');
  let view = $state<View>('side-by-side');
  let ignoreWhitespace = $state(false);
  let showAll = $state<boolean>(false);
  let output = $state<TaskOutput | undefined>(undefined);
  let working = $state(false);
  let status = $state('');
  let failure = $state('');

  let pool: WorkerPool<TaskInput, TaskOutput> | undefined;
  let controller: AbortController | undefined;

  $effect(() => () => {
    controller?.abort();
    pool?.terminate();
  });

  const beforeError = $derived(
    before.length > MAX_TEXT_LENGTH ? t('diff.tooLong', { max: MAX_TEXT_LENGTH }) : '',
  );
  const afterError = $derived(
    after.length > MAX_TEXT_LENGTH ? t('diff.tooLong', { max: MAX_TEXT_LENGTH }) : '',
  );
  const ready = $derived(beforeError === '' && afterError === '');

  const unitOptions = $derived([
    { value: 'lines', label: t('diff.unit.lines') },
    { value: 'words', label: t('diff.unit.words') },
  ]);
  const viewOptions = $derived([
    { value: 'side-by-side', label: t('diff.view.sideBySide') },
    { value: 'inline', label: t('diff.view.inline') },
  ]);

  // The comparison waits for a pause in typing, runs in a worker and is stopped when it takes too long.
  $effect(() => {
    if (!ready) {
      controller?.abort();
      controller = undefined;
      output = undefined;
      working = false;
      status = '';
      failure = '';
      return;
    }
    const input: TaskInput = {
      before,
      after,
      unit,
      ignoreWhitespace,
      context: showAll ? -1 : DEFAULT_CONTEXT,
    };
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
    const timeoutError = new Error('the comparison took too long');
    const timeout = setTimeout(() => {
      own.abort(timeoutError);
    }, DIFF_TIMEOUT_MS);
    working = true;
    try {
      const result = await pool.run(input, { signal: own.signal });
      if (controller !== own) {
        return;
      }
      output = result;
      failure = '';
      status = summary(result);
    } catch {
      if (own.signal.reason === timeoutError) {
        output = undefined;
        status = '';
        failure = t('diff.timeout', { seconds: DIFF_TIMEOUT_MS / 1000 });
      } else if (controller === own) {
        // Not stopped by a newer edit: the worker itself failed.
        output = undefined;
        status = '';
        failure = t('diff.failed');
      }
    } finally {
      clearTimeout(timeout);
      if (controller === own) {
        working = false;
      }
    }
  }

  function summary(result: TaskOutput): string {
    const { added, removed } = result.stats;
    if (added === 0 && removed === 0) {
      return t('diff.identical');
    }
    const key = result.unit === 'lines' ? 'diff.summary.lines' : 'diff.summary.words';
    return t(key, { added, removed });
  }

  const rightPart = $derived(output?.unit === 'words' ? rightSide(output.segments) : []);
  const leftPart = $derived(output?.unit === 'words' ? leftSide(output.segments) : []);
</script>

{#snippet marked(segments: readonly Segment[])}
  {#each segments as segment, index (index)}
    {#if segment.kind === 'removed'}
      <del>{segment.text}</del>
    {:else if segment.kind === 'added'}
      <ins>{segment.text}</ins>
    {:else}
      <span>{segment.text}</span>
    {/if}
  {/each}
{/snippet}

<ToolFrame id="diff">
  <div class="tool">
    <section class="block">
      <h2 class="heading">{t('diff.texts')}</h2>
      <div class="pair">
        <Textarea
          label={t('diff.before')}
          bind:value={before}
          error={beforeError}
          rows={10}
          spellcheck={false}
        />
        <Textarea
          label={t('diff.after')}
          bind:value={after}
          error={afterError}
          rows={10}
          spellcheck={false}
        />
      </div>
    </section>

    <section class="block">
      <h2 class="heading">{t('diff.options')}</h2>
      <div class="pair">
        <Select label={t('diff.unit')} options={unitOptions} bind:value={unit} />
        <Select label={t('diff.view')} options={viewOptions} bind:value={view} />
      </div>
      <Checkbox label={t('diff.ignoreWhitespace')} bind:checked={ignoreWhitespace} />
      {#if unit === 'lines'}
        <Checkbox label={t('diff.showAll')} bind:checked={showAll} />
      {/if}
    </section>

    <section class="block wide" aria-busy={working}>
      <h2 class="heading">{t('diff.result')}</h2>
      <StatusMessage data-tool-status tone="ok" message={status} />
      <StatusMessage data-tool-status kind="alert" message={failure} />
      {#if working && output === undefined}
        <p class="note">{t('diff.working')}</p>
      {/if}
      {#if output?.unit === 'lines'}
        {#if output.degraded}
          <p class="note">{t('diff.degraded')}</p>
        {/if}
        {#if output.stats.added === 0 && output.stats.removed === 0}
          <p class="note">{t('diff.identical')}</p>
        {:else if view === 'side-by-side'}
          <table class="diff" aria-label={t('diff.table.sideBySide')}>
            <colgroup>
              <col class="num" />
              <col class="mark" />
              <col class="text" />
              <col class="num" />
              <col class="mark" />
              <col class="text" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" colspan="3">{t('diff.before')}</th>
                <th scope="col" colspan="3">{t('diff.after')}</th>
              </tr>
            </thead>
            <tbody>
              {#each output.rows as row, index (index)}
                {#if row.kind === 'skipped'}
                  <tr class="skipped">
                    <td colspan="6">{t('diff.skipped', { count: row.count })}</td>
                  </tr>
                {:else if row.kind === 'same'}
                  <tr>
                    <td class="num">{row.before}</td>
                    <td class="mark"></td>
                    <td class="text">{row.text}</td>
                    <td class="num">{row.after}</td>
                    <td class="mark"></td>
                    <td class="text">{row.text}</td>
                  </tr>
                {:else if row.kind === 'removed'}
                  <tr>
                    <td class="num">{row.before}</td>
                    <td class="mark removed"
                      ><span aria-hidden="true">−</span><VisuallyHidden
                        >{t('diff.removedLine')}</VisuallyHidden
                      ></td
                    >
                    <td class="text removed">{@render marked(row.left)}</td>
                    <td class="num"></td>
                    <td class="mark"></td>
                    <td class="text"></td>
                  </tr>
                {:else if row.kind === 'added'}
                  <tr>
                    <td class="num"></td>
                    <td class="mark"></td>
                    <td class="text"></td>
                    <td class="num">{row.after}</td>
                    <td class="mark added"
                      ><span aria-hidden="true">+</span><VisuallyHidden
                        >{t('diff.addedLine')}</VisuallyHidden
                      ></td
                    >
                    <td class="text added">{@render marked(row.right)}</td>
                  </tr>
                {:else}
                  <tr>
                    <td class="num">{row.before}</td>
                    <td class="mark removed"
                      ><span aria-hidden="true">−</span><VisuallyHidden
                        >{t('diff.removedLine')}</VisuallyHidden
                      ></td
                    >
                    <td class="text removed">{@render marked(row.left)}</td>
                    <td class="num">{row.after}</td>
                    <td class="mark added"
                      ><span aria-hidden="true">+</span><VisuallyHidden
                        >{t('diff.addedLine')}</VisuallyHidden
                      ></td
                    >
                    <td class="text added">{@render marked(row.right)}</td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        {:else}
          <table class="diff" aria-label={t('diff.table.inline')}>
            <colgroup>
              <col class="num" />
              <col class="num" />
              <col class="mark" />
              <col class="text" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{t('diff.before')}</th>
                <th scope="col">{t('diff.after')}</th>
                <th scope="col"><VisuallyHidden>{t('diff.change')}</VisuallyHidden></th>
                <th scope="col">{t('diff.line')}</th>
              </tr>
            </thead>
            <tbody>
              {#each output.rows as row, index (index)}
                {#if row.kind === 'skipped'}
                  <tr class="skipped">
                    <td colspan="4">{t('diff.skipped', { count: row.count })}</td>
                  </tr>
                {:else if row.kind === 'same'}
                  <tr>
                    <td class="num">{row.before}</td>
                    <td class="num">{row.after}</td>
                    <td class="mark"></td>
                    <td class="text">{row.text}</td>
                  </tr>
                {:else}
                  {#if row.kind === 'removed' || row.kind === 'changed'}
                    <tr>
                      <td class="num">{row.before}</td>
                      <td class="num"></td>
                      <td class="mark removed"
                        ><span aria-hidden="true">−</span><VisuallyHidden
                          >{t('diff.removedLine')}</VisuallyHidden
                        ></td
                      >
                      <td class="text removed">{@render marked(row.left)}</td>
                    </tr>
                  {/if}
                  {#if row.kind === 'added' || row.kind === 'changed'}
                    <tr>
                      <td class="num"></td>
                      <td class="num">{row.after}</td>
                      <td class="mark added"
                        ><span aria-hidden="true">+</span><VisuallyHidden
                          >{t('diff.addedLine')}</VisuallyHidden
                        ></td
                      >
                      <td class="text added">{@render marked(row.right)}</td>
                    </tr>
                  {/if}
                {/if}
              {/each}
            </tbody>
          </table>
        {/if}
        {#if output.truncated}
          <p class="note">{t('diff.truncated', { count: MAX_ROWS })}</p>
        {/if}
      {:else if output?.unit === 'words'}
        {#if output.degraded}
          <p class="note">{t('diff.degraded')}</p>
        {/if}
        {#if output.stats.added === 0 && output.stats.removed === 0}
          <p class="note">{t('diff.identical')}</p>
        {:else if view === 'side-by-side'}
          <div class="pair flow-pair">
            <div class="flow-box">
              <h3 class="subheading">{t('diff.before')}</h3>
              <p class="flow">{@render marked(leftPart)}</p>
            </div>
            <div class="flow-box">
              <h3 class="subheading">{t('diff.after')}</h3>
              <p class="flow">{@render marked(rightPart)}</p>
            </div>
          </div>
        {:else}
          <p class="flow">{@render marked(output.segments)}</p>
        {/if}
      {/if}
    </section>
  </div>
</ToolFrame>

<style>
  .tool {
    display: flex;
    flex-direction: column;
    gap: var(--k-space-8);
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: var(--k-space-4);
    max-width: 1100px;
  }

  .heading {
    margin: 0;
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.4px;
  }

  .subheading {
    margin: 0 0 var(--k-space-2);
    font: 12px var(--k-font-mono);
    letter-spacing: 1px;
    color: var(--k-fg-muted);
    text-transform: uppercase;
    font-weight: 400;
  }

  .pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
    gap: var(--k-space-4);
  }

  .note {
    margin: 0;
    font: 13px var(--k-font-mono);
    color: var(--k-fg-muted);
  }

  .diff {
    width: 100%;
    table-layout: fixed;
    border-collapse: collapse;
    font: 13px/1.5 var(--k-font-mono);
  }

  .diff th {
    padding: var(--k-space-2);
    text-align: left;
    font-weight: 400;
    color: var(--k-fg-muted);
    border-bottom: 1px solid var(--k-line-strong);
  }

  .diff td {
    padding: 0 var(--k-space-2);
    vertical-align: top;
    border-bottom: 1px solid var(--k-line);
  }

  col.num {
    width: 2.75em;
  }

  col.mark {
    width: 1.75em;
  }

  .num {
    color: var(--k-fg-muted);
    text-align: right;
  }

  .mark {
    text-align: center;
  }

  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .added {
    background: rgb(61 220 132 / 14%);
  }

  .removed {
    background: rgb(255 79 139 / 16%);
  }

  .skipped td {
    padding: var(--k-space-2);
    color: var(--k-fg-muted);
    text-align: center;
    background: var(--k-line);
  }

  ins,
  del {
    text-decoration-thickness: 2px;
    text-underline-offset: 2px;
  }

  ins {
    text-decoration: underline;
    background: rgb(61 220 132 / 35%);
  }

  del {
    text-decoration: line-through;
    background: rgb(255 79 139 / 38%);
  }

  .flow {
    margin: 0;
    padding: var(--k-space-3) var(--k-space-3-5);
    border: 1px solid var(--k-line);
    font: 14px/1.6 var(--k-font-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .flow-box {
    min-width: 0;
  }
</style>
