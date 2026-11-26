<script lang="ts">
  import { Input, Checkbox, Textarea } from '@mozra-the-great/kern';
  import type { WorkerPool } from '@stuffcloud/tools';
  import { t } from '../../i18n/index.ts';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import ToolStatus from '../../app/ToolStatus.svelte';
  import { explainPattern } from './explain.ts';
  import {
    DEBOUNCE_MS,
    FLAGS,
    MATCH_TIMEOUT_MS,
    MAX_MATCHES,
    MAX_PATTERN_LENGTH,
    MAX_TEXT_LENGTH,
    compileError,
    type Flag,
    type Input as TaskInput,
    type Match,
    type Output as TaskOutput,
  } from './match.ts';
  import { EXPLAIN_KEYS, FLAG_KEYS } from './messages.ts';
  import { createPool } from './pool.ts';

  let pattern = $state(String.raw`(\d{4})-(\d{2})-(\d{2})`);
  let text = $state('Released 2026-06-01, patched 2026-06-15.');
  const enabled = $state<Record<Flag, boolean>>({
    g: true,
    i: false,
    m: false,
    s: false,
    u: false,
    v: false,
    y: false,
  });
  let output = $state<TaskOutput | undefined>(undefined);
  let status = $state('');
  let failure = $state('');

  let pool: WorkerPool<TaskInput, TaskOutput> | undefined;
  let controller: AbortController | undefined;

  $effect(() => () => {
    controller?.abort();
    pool?.terminate();
  });

  const flags = $derived(FLAGS.filter((flag) => enabled[flag]).join(''));

  const patternProblem = $derived.by((): string => {
    if (pattern === '') {
      return '';
    }
    if (pattern.length > MAX_PATTERN_LENGTH) {
      return t('regex.patternTooLong', { max: MAX_PATTERN_LENGTH });
    }
    const message = compileError(pattern, flags);
    return message === undefined ? '' : t('regex.invalid', { message });
  });
  const textProblem = $derived(
    text.length > MAX_TEXT_LENGTH ? t('regex.textTooLong', { max: MAX_TEXT_LENGTH }) : '',
  );
  const ready = $derived(pattern !== '' && patternProblem === '' && textProblem === '');

  const explanation = $derived(
    pattern !== '' && patternProblem === '' ? explainPattern(pattern, flags) : [],
  );

  // Matching waits for a pause in typing, runs in a worker and is stopped when it takes too long.
  $effect(() => {
    if (!ready) {
      // A match that is still running belongs to input that is gone: stop it, and drop its answer.
      controller?.abort();
      controller = undefined;
      output = undefined;
      failure = '';
      status = '';
      return;
    }
    const input: TaskInput = { pattern, flags, text, maxMatches: MAX_MATCHES };
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
    const timeoutError = new Error('the match took too long');
    const timeout = setTimeout(() => {
      own.abort(timeoutError);
    }, MATCH_TIMEOUT_MS);
    try {
      const result = await pool.run(input, { signal: own.signal });
      if (controller !== own) {
        return;
      }
      output = result;
      failure = '';
      status = result.truncated
        ? t('regex.truncated', { count: result.matches.length })
        : result.matches.length === 0
          ? t('regex.none')
          : t('regex.count', { count: result.matches.length });
    } catch {
      if (own.signal.reason === timeoutError) {
        output = undefined;
        status = '';
        failure = t('regex.timeout', { seconds: MATCH_TIMEOUT_MS / 1000 });
      } else if (controller === own) {
        // Not stopped by a newer edit: the worker itself failed.
        output = undefined;
        status = '';
        failure = t('regex.failed');
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  interface Segment {
    readonly text: string;
    readonly marked: boolean;
  }

  /** The test text cut at the matches, so the matched parts can be marked. */
  const segments = $derived.by((): Segment[] => {
    if (output === undefined) {
      return [];
    }
    const parts: Segment[] = [];
    let position = 0;
    for (const match of output.matches) {
      if (match.text === '' || match.index < position) {
        continue;
      }
      if (match.index > position) {
        parts.push({ text: text.slice(position, match.index), marked: false });
      }
      parts.push({ text: match.text, marked: true });
      position = match.index + match.text.length;
    }
    if (position < text.length) {
      parts.push({ text: text.slice(position), marked: false });
    }
    return parts;
  });

  function groupRows(match: Match): { label: string; value: string | undefined }[] {
    return [
      ...match.groups.map((value, index) => ({ label: String(index + 1), value })),
      ...match.named.map(([name, value]) => ({ label: name, value })),
    ];
  }

  function explainText(item: (typeof explanation)[number]): string {
    const base = t(EXPLAIN_KEYS[item.key], item.params);
    return item.lazy ? `${base}, ${t('regex.explain.lazy')}` : base;
  }
</script>

<ToolFrame id="regex">
  <div class="tool">
    <section class="block">
      <Input
        keepHint
        label={t('regex.pattern')}
        hint={t('regex.patternHint')}
        bind:value={pattern}
        error={patternProblem}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
      />
      <fieldset class="flags">
        <legend class="legend">{t('regex.flags')}</legend>
        {#each FLAGS as flag (flag)}
          <Checkbox label={t(FLAG_KEYS[flag])} bind:checked={enabled[flag]} />
        {/each}
      </fieldset>
      <Textarea
        label={t('regex.text')}
        bind:value={text}
        error={textProblem}
        rows={6}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
      />
      <ToolStatus message={status} />
      <ToolStatus kind="alert" message={failure} />
    </section>

    {#if output !== undefined}
      <section class="block">
        <h2 class="heading">{t('regex.marked')}</h2>
        <p class="marked">
          {#each segments as segment, index (index)}{#if segment.marked}<mark>{segment.text}</mark
              >{:else}{segment.text}{/if}{/each}
        </p>
      </section>

      {#if output.matches.length > 0}
        <section class="block">
          <h2 class="heading">{t('regex.matches')}</h2>
          <table aria-label={t('regex.matches.caption')}>
            <thead>
              <tr>
                <th scope="col">{t('regex.col.number')}</th>
                <th scope="col">{t('regex.col.position')}</th>
                <th scope="col">{t('regex.col.match')}</th>
                <th scope="col">{t('regex.col.groups')}</th>
              </tr>
            </thead>
            <tbody>
              {#each output.matches as match, index (index)}
                <tr>
                  <th scope="row">{index + 1}</th>
                  <td>{match.index}</td>
                  <td class="code">{match.text === '' ? t('regex.empty') : match.text}</td>
                  <td>
                    {#if groupRows(match).length > 0}
                      <ul class="groups">
                        {#each groupRows(match) as row (row.label)}
                          <li>
                            <span class="group-name">{row.label}</span>
                            <span class="code"
                              >{row.value === undefined
                                ? t('regex.notTaken')
                                : row.value === ''
                                  ? t('regex.empty')
                                  : row.value}</span
                            >
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
      {/if}
    {/if}

    {#if explanation.length > 0}
      <section class="block">
        <h2 class="heading">{t('regex.explanation')}</h2>
        <ul class="explain">
          {#each explanation as item, index (index)}
            <li class="d{Math.min(item.depth, 6)}">
              <code class="source">{item.source}</code>
              <span>{explainText(item)}</span>
            </li>
          {/each}
        </ul>
        <p class="note">{t('regex.note')}</p>
      </section>
    {/if}
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
    max-width: 760px;
  }

  .heading {
    margin: 0;
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.4px;
  }

  .flags {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    margin: 0;
    padding: 0;
    border: 0;
  }

  .legend {
    padding: 0 0 var(--k-space-2);
    font: 12px var(--k-font-mono);
    letter-spacing: 1px;
    color: var(--k-fg-muted);
    text-transform: uppercase;
  }

  .marked {
    margin: 0;
    font: 15px/1.6 var(--k-font-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  mark {
    background: var(--k-accent);
    color: var(--k-bg);
    font-weight: 700;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  table {
    border-collapse: collapse;
    width: 100%;
    font: 14px var(--k-font-mono);
  }

  th,
  td {
    padding: var(--k-space-2) var(--k-space-3);
    border-bottom: 1px solid var(--k-line);
    text-align: left;
    font-weight: 400;
    vertical-align: top;
    overflow-wrap: anywhere;
  }

  thead th {
    color: var(--k-fg-muted);
  }

  .code {
    white-space: pre-wrap;
  }

  .groups {
    display: flex;
    flex-direction: column;
    gap: var(--k-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .group-name {
    margin-right: var(--k-space-2);
    color: var(--k-fg-muted);
  }

  .explain {
    display: flex;
    flex-direction: column;
    gap: var(--k-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
    font: 14px/1.5 var(--k-font-mono);
  }

  .source {
    margin-right: var(--k-space-3);
    padding: 2px var(--k-space-2);
    border: 1px solid var(--k-line);
    border-radius: 4px;
    white-space: pre-wrap;
  }

  .d1 {
    padding-left: var(--k-space-5);
  }

  .d2 {
    padding-left: var(--k-space-8);
  }

  .d3 {
    padding-left: calc(var(--k-space-5) * 3);
  }

  .d4 {
    padding-left: calc(var(--k-space-5) * 4);
  }

  .d5 {
    padding-left: calc(var(--k-space-5) * 5);
  }

  .d6 {
    padding-left: calc(var(--k-space-5) * 6);
  }

  .note {
    margin: 0;
    font: 13px var(--k-font-mono);
    color: var(--k-fg-muted);
  }
</style>
