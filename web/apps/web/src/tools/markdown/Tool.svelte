<script lang="ts">
  import { Textarea } from '@mozra-the-great/kern';
  import type { WorkerPool } from '@stuffcloud/tools';
  import { t } from '../../i18n/index.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import ToolStatus from '../../app/ToolStatus.svelte';
  import type { Input as TaskInput, Output as TaskOutput } from './parse.ts';
  import { createPool } from './pool.ts';
  import { MAX_MARKDOWN_CHARS, sanitiseHtml, toPreview } from './render.ts';

  /** The page waits this long after the last edit before it renders. */
  const DEBOUNCE_MS = 250;
  /** `marked` can take minutes for some texts; its worker is stopped after this long. */
  const TIMEOUT_MS = 8000;

  let text = $state(t('markdown.sample'));
  let html = $state('');
  let status = $state('');
  let failure = $state('');
  let container: HTMLElement | undefined = $state();

  let pool: WorkerPool<TaskInput, TaskOutput> | undefined;
  let controller: AbortController | undefined;

  $effect(() => () => {
    controller?.abort();
    pool?.terminate();
  });

  const tooLong = $derived(text.length > MAX_MARKDOWN_CHARS);

  // Rendering waits for a pause in typing. `marked` runs in a worker that is stopped on a timeout; the
  // answer is cleaned and put into the page as nodes, never as a string.
  $effect(() => {
    if (container === undefined) {
      return;
    }
    const target = container;
    if (tooLong) {
      controller?.abort();
      controller = undefined;
      target.replaceChildren();
      html = '';
      status = '';
      failure = t('markdown.tooLong', { max: MAX_MARKDOWN_CHARS });
      return;
    }
    const source = text;
    const timer = setTimeout(() => {
      void render(source, target);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  });

  async function render(source: string, target: HTMLElement): Promise<void> {
    controller?.abort();
    pool ??= createPool();
    const own = new AbortController();
    controller = own;
    const timeoutError = new Error('the text took too long to render');
    const timeout = setTimeout(() => {
      own.abort(timeoutError);
    }, TIMEOUT_MS);
    try {
      const parsed = await pool.run({ source }, { signal: own.signal });
      if (controller !== own) {
        return;
      }
      const clean = sanitiseHtml(parsed);
      const preview = toPreview(clean, {
        blockedImage: (alt) =>
          alt === '' ? t('markdown.blockedImageNoAlt') : t('markdown.blockedImage', { alt }),
        taskDone: t('markdown.taskDone'),
        taskOpen: t('markdown.taskOpen'),
      });
      target.replaceChildren(...preview.nodes);
      html = clean;
      failure = '';
      status =
        preview.blockedImages > 0
          ? t('markdown.renderedBlocked', { count: preview.blockedImages })
          : t('markdown.rendered');
    } catch {
      if (own.signal.reason === timeoutError) {
        status = '';
        failure = t('markdown.timeout', { seconds: TIMEOUT_MS / 1000 });
      } else if (controller === own) {
        // Not stopped by a newer edit: the worker itself failed.
        status = '';
        failure = t('markdown.failed');
      }
    } finally {
      clearTimeout(timeout);
    }
  }
</script>

<ToolFrame id="markdown">
  <div class="tool">
    <div class="columns">
      <section class="block">
        <Textarea
          label={t('markdown.input')}
          bind:value={text}
          rows={18}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
        />
        <ToolStatus message={status} />
        <ToolStatus kind="alert" message={failure} />
      </section>

      <section class="block">
        <h2 class="heading">{t('markdown.preview')}</h2>
        <div class="preview" bind:this={container}></div>
        <div>
          <CopyButton text={html} label={t('markdown.copyHtml')} value={t('markdown.copiedHtml')} />
        </div>
      </section>
    </div>
    <p class="note">{t('markdown.note')}</p>
  </div>
</ToolFrame>

<style>
  .tool {
    display: flex;
    flex-direction: column;
    gap: var(--space-24);
  }

  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
    gap: var(--space-40);
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-16);
    min-width: 0;
  }

  .heading {
    margin: 0;
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.4px;
  }

  .note {
    margin: 0;
    max-width: 760px;
    font: 13px/1.5 var(--mono);
    color: var(--mut);
  }

  .preview {
    min-width: 0;
    padding: var(--space-16);
    border: 1px solid var(--line2);
    border-radius: 8px;
    font-size: 15px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }

  /* The nodes come from the sanitiser; their styles are written here, once. */
  .preview :global(> :first-child) {
    margin-top: 0;
  }

  .preview :global(> :last-child) {
    margin-bottom: 0;
  }

  .preview :global(h3),
  .preview :global(h4),
  .preview :global(h5),
  .preview :global(h6) {
    margin: var(--space-24) 0 var(--space-8);
    font-weight: 600;
    line-height: 1.3;
  }

  .preview :global(h3) {
    font-size: 22px;
  }

  .preview :global(h4) {
    font-size: 18px;
  }

  .preview :global(h5),
  .preview :global(h6) {
    font-size: 15px;
  }

  .preview :global(p),
  .preview :global(ul),
  .preview :global(ol),
  .preview :global(blockquote),
  .preview :global(pre),
  .preview :global(table),
  .preview :global(details),
  .preview :global(dl) {
    margin: 0 0 var(--space-16);
  }

  .preview :global(ul),
  .preview :global(ol) {
    padding-left: var(--space-24);
  }

  .preview :global(a) {
    color: var(--pink);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .preview :global(code),
  .preview :global(kbd),
  .preview :global(samp) {
    font: 0.9em var(--mono);
    padding: 1px 5px;
    border: 1px solid var(--line2);
    border-radius: 4px;
  }

  .preview :global(pre) {
    padding: var(--space-12) var(--space-16);
    border: 1px solid var(--line2);
    border-radius: 6px;
    white-space: pre-wrap;
  }

  .preview :global(pre code) {
    padding: 0;
    border: 0;
  }

  .preview :global(blockquote) {
    padding-left: var(--space-16);
    border-left: 3px solid var(--line2);
    color: var(--mut);
  }

  .preview :global(table) {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }

  .preview :global(th),
  .preview :global(td) {
    padding: var(--space-8) var(--space-12);
    border: 1px solid var(--line2);
    text-align: left;
    vertical-align: top;
  }

  .preview :global(th[align='center']),
  .preview :global(td[align='center']) {
    text-align: center;
  }

  .preview :global(th[align='right']),
  .preview :global(td[align='right']) {
    text-align: right;
  }

  .preview :global(hr) {
    border: 0;
    border-top: 1px solid var(--line2);
    margin: var(--space-24) 0;
  }

  .preview :global(mark) {
    background: var(--pink);
    color: var(--bg);
  }

  .preview :global(.blocked-image) {
    font: 13px var(--mono);
    color: var(--mut);
  }

  .preview :global(img) {
    max-width: 100%;
    height: auto;
  }
</style>
