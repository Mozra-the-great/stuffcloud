<script lang="ts">
  import {
    Input,
    Progress,
    Select,
    Button,
    FileDrop,
    Textarea,
    StatusMessage,
  } from '@mozra-the-great/kern';
  import type { WorkerPool } from '@stuffcloud/tools';
  import { i18n, t } from '../../i18n/index.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import {
    ALGORITHMS,
    digestText,
    fromHex,
    matchingAlgorithms,
    parseExpected,
    toBase64,
    type Digests,
  } from './digest.ts';
  import { createPool } from './pool.ts';
  import type { Input as TaskInput, Output as TaskOutput } from './task.ts';

  type Format = 'hex' | 'hex-upper' | 'base64';

  interface FileResult {
    readonly name: string;
    readonly size: number;
    readonly digests: Digests;
  }

  let mode = $state<'text' | 'file'>('text');
  let format = $state<Format>('hex');
  let text = $state('');
  let expected = $state('');
  let textDigests = $state<Digests | undefined>(undefined);
  let fileResult = $state<FileResult | undefined>(undefined);
  let fileName = $state('');
  let working = $state(false);
  let done = $state(0);
  let total = $state(1);
  let status = $state('');
  let failure = $state('');

  let pool: WorkerPool<TaskInput, TaskOutput> | undefined;
  let controller: AbortController | undefined;
  let textRun = 0;

  $effect(() => () => {
    controller?.abort();
    pool?.terminate();
  });

  // The text is hashed as it changes; an answer that arrives after a newer edit is dropped.
  $effect(() => {
    if (mode !== 'text') {
      return;
    }
    const current = text;
    textRun += 1;
    const run = textRun;
    digestText(current).then(
      (digests) => {
        if (run === textRun) {
          textDigests = digests;
        }
      },
      () => {
        if (run === textRun) {
          failure = t('hash.failed');
        }
      },
    );
  });

  const digests = $derived(mode === 'text' ? textDigests : fileResult?.digests);

  const modeOptions = $derived([
    { value: 'text', label: t('hash.mode.text') },
    { value: 'file', label: t('hash.mode.file') },
  ]);
  const formatOptions = $derived([
    { value: 'hex', label: t('hash.format.hex') },
    { value: 'hex-upper', label: t('hash.format.hexUpper') },
    { value: 'base64', label: t('hash.format.base64') },
  ]);

  function shown(hex: string): string {
    if (format === 'hex-upper') {
      return hex.toUpperCase();
    }
    return format === 'base64' ? toBase64(fromHex(hex)) : hex;
  }

  const expectedInfo = $derived(parseExpected(expected));
  const matches = $derived(
    digests === undefined || expectedInfo.kind !== 'hex'
      ? []
      : matchingAlgorithms(digests, expectedInfo.hex),
  );
  const algorithmNames = $derived(
    new Intl.ListFormat(i18n.locale, { style: 'long', type: 'disjunction' }),
  );
  const verdict = $derived.by((): string => {
    if (expectedInfo.kind !== 'hex') {
      return '';
    }
    return matches.length > 0
      ? t('hash.compare.match', { algorithm: algorithmNames.format(matches) })
      : t('hash.compare.none');
  });
  const expectedError = $derived(expectedInfo.kind === 'invalid' ? t('hash.compare.invalid') : '');

  const bytes = $derived(new Intl.NumberFormat(i18n.locale));

  async function hashFile(file: File): Promise<void> {
    controller?.abort();
    pool ??= createPool();
    const own = new AbortController();
    controller = own;
    fileResult = undefined;
    fileName = file.name;
    failure = '';
    status = '';
    done = 0;
    total = Math.max(file.size, 1);
    working = true;
    try {
      const output = await pool.run(
        { file },
        {
          signal: own.signal,
          onProgress: (progress) => {
            done = progress.completed;
            total = progress.total;
          },
        },
      );
      fileResult = { name: file.name, size: output.size, digests: output.digests };
      status = t('hash.announce.file', { name: file.name });
    } catch {
      if (own.signal.aborted) {
        if (controller === own) {
          status = t('hash.cancelled');
        }
      } else {
        failure = t('hash.failed');
      }
    } finally {
      if (controller === own) {
        working = false;
      }
    }
  }

  function onfiles(files: File[]): void {
    const [file] = files;
    if (file !== undefined) {
      void hashFile(file);
    }
  }

  function cancel(): void {
    controller?.abort();
  }

  function announceText(): void {
    status = digests === undefined ? '' : t('hash.announce.text');
  }

  function announceVerdict(): void {
    status = expectedError !== '' ? expectedError : verdict;
  }

  function onmode(): void {
    status = '';
    failure = '';
  }
</script>

<ToolFrame id="hash">
  <div class="tool">
    <section class="block">
      <Select label={t('hash.mode')} options={modeOptions} bind:value={mode} onchange={onmode} />
      {#if mode === 'text'}
        <Textarea
          rows={5}
          label={t('hash.text')}
          hint={t('hash.textHint')}
          bind:value={text}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          onchange={announceText}
        />
      {:else}
        <FileDrop
          mode="dispatch"
          rejectMessages={false}
          statusLabel=""
          dropLabel={t('hash.dropHint')}
          buttonLabel={t('hash.choose')}
          multiple={false}
          disabled={working}
          {onfiles}
        />
        {#if fileName !== ''}
          <p class="note">
            {fileResult === undefined
              ? t('hash.file', { name: fileName })
              : t('hash.fileSize', {
                  name: fileResult.name,
                  size: bytes.format(fileResult.size),
                })}
          </p>
        {/if}
        {#if working}
          <Progress
            hideLabel
            label={t('hash.progress', { name: fileName })}
            value={done}
            max={total}
            valueText={t('hash.progressText', {
              done: bytes.format(done),
              total: bytes.format(total),
            })}
          />
          <div>
            <Button variant="secondary" size="sm" onclick={cancel}>{t('hash.cancel')}</Button>
          </div>
        {/if}
      {/if}
      <StatusMessage data-tool-status class="tool-ok" message={status} />
      <StatusMessage data-tool-status kind="alert" message={failure} />
    </section>

    {#if digests !== undefined}
      <section class="block">
        <h2 class="heading">{t('hash.results')}</h2>
        <Select label={t('hash.format')} options={formatOptions} bind:value={format} />
        <ul class="digests">
          {#each ALGORITHMS as algorithm (algorithm)}
            <li class="digest">
              <span class="algorithm">{algorithm}</span>
              <code class="value">{shown(digests[algorithm])}</code>
              <CopyButton
                text={shown(digests[algorithm])}
                label={t('hash.copy', { algorithm })}
                value={algorithm}
              />
            </li>
          {/each}
        </ul>
        <p class="note">{t('hash.sha1Note')}</p>
      </section>

      <section class="block">
        <h2 class="heading">{t('hash.compare')}</h2>
        <Input
          keepHint
          label={t('hash.compare.label')}
          hint={t('hash.compare.hint')}
          bind:value={expected}
          error={expectedError}
          announce={false}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          onchange={announceVerdict}
        />
        {#if verdict !== ''}
          <p class="verdict">{verdict}</p>
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

  .digests {
    display: flex;
    flex-direction: column;
    gap: var(--space-16);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .digest {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-8) var(--space-16);
  }

  .algorithm {
    flex: 0 0 5.5rem;
    font: 12px var(--mono);
    letter-spacing: 1px;
    color: var(--mut);
    text-transform: uppercase;
  }

  .value {
    flex: 1 1 18rem;
    font: 14px/1.5 var(--mono);
    overflow-wrap: anywhere;
  }

  .note {
    margin: 0;
    font: 13px var(--mono);
    color: var(--mut);
  }

  .verdict {
    margin: 0;
    font: 500 16px/1.4 var(--mono);
  }
</style>
