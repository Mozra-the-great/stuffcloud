<script lang="ts">
  import {
    Input,
    Progress,
    Select,
    Button,
    FileDrop,
    Checkbox,
    Textarea,
  } from '@mozra-the-great/kern';
  import type { WorkerPool } from '@stuffcloud/tools';
  import { t } from '../../i18n/index.ts';
  import { saveBlob, saveText } from '../../app/download.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import ToolStatus from '../../app/ToolStatus.svelte';
  import {
    MAX_DECODE_FILE_BYTES,
    MAX_FILE_BYTES,
    MAX_TEXT_CHARS,
    asText,
    dataUri,
    decodeBase64,
    decodedFileName,
    downloadType,
    encodeBytes,
    hexHead,
    isMediaType,
    type EncodeOptions,
  } from './codec.ts';
  import { decodeErrorText, formatSize } from './messages.ts';
  import { createPool } from './pool.ts';
  import type { Input as TaskInput, Output as TaskOutput } from './task.ts';

  const STATUS_DELAY_MS = 400;
  /** The result is shown up to this many characters; copy and download use all of it. */
  const SHOWN_CHARS = 20_000;
  const TEXT_TYPE = 'text/plain;charset=utf-8';

  type Direction = 'encode' | 'decode';
  type Source = 'text' | 'file';

  interface Decoded {
    readonly bytes: Uint8Array;
    readonly mediaType: string | undefined;
  }

  let direction = $state<Direction>('encode');
  let source = $state<Source>('text');
  let text = $state('Hello, stuffcloud!');
  let urlSafe = $state(false);
  let padding = $state(true);
  let lines = $state<'0' | '64' | '76'>('0');
  let asUri = $state(false);
  /** What the visitor typed as the media type; until then it follows the source. */
  let typedType = $state<string | undefined>(undefined);
  let file = $state<File | undefined>(undefined);
  let fileEncoded = $state<string | undefined>(undefined);
  let fileDecoded = $state<Decoded | undefined>(undefined);
  let fileFailure = $state('');
  let working = $state(false);
  let done = $state(0);
  let total = $state(1);
  let status = $state('');
  let failure = $state('');

  let pool: WorkerPool<TaskInput, TaskOutput> | undefined;
  let controller: AbortController | undefined;

  $effect(() => () => {
    controller?.abort();
    pool?.terminate();
  });

  const directionOptions = $derived([
    { value: 'encode', label: t('base64.direction.encode') },
    { value: 'decode', label: t('base64.direction.decode') },
  ]);
  const sourceOptions = $derived([
    { value: 'text', label: t('base64.source.text') },
    { value: 'file', label: t('base64.source.file') },
  ]);
  const lineOptions = $derived([
    { value: '0', label: t('base64.lines.none') },
    { value: '76', label: t('base64.lines.76') },
    { value: '64', label: t('base64.lines.64') },
  ]);

  const mediaType = $derived(
    typedType ?? (source === 'file' ? (file?.type ?? '') || 'application/octet-stream' : TEXT_TYPE),
  );
  const mediaProblem = $derived(
    direction === 'encode' && asUri && !isMediaType(mediaType) ? t('base64.mediaTypeInvalid') : '',
  );
  const options = $derived<EncodeOptions>({
    urlSafe: urlSafe && !asUri,
    padding: padding || asUri,
    lineLength: asUri ? 0 : lines === '76' ? 76 : lines === '64' ? 64 : 0,
  });
  const dataType = $derived(asUri && mediaProblem === '' ? mediaType : undefined);

  // -- text: done on the page, the length is limited ------------------------------------------

  const tooLong = $derived(source === 'text' && text.length > MAX_TEXT_CHARS);

  const encodedText = $derived.by((): string | undefined => {
    if (direction !== 'encode' || source !== 'text' || tooLong || text === '') {
      return undefined;
    }
    const base64 = encodeBytes(new TextEncoder().encode(text), options);
    return dataType === undefined ? base64 : dataUri(dataType, base64);
  });

  const decodedText = $derived.by(() => {
    if (direction !== 'decode' || source !== 'text' || tooLong || text.trim() === '') {
      return undefined;
    }
    return decodeBase64(text);
  });

  const decoded = $derived.by((): Decoded | undefined => {
    if (source === 'file') {
      return direction === 'decode' ? fileDecoded : undefined;
    }
    return decodedText?.ok === true
      ? { bytes: decodedText.bytes, mediaType: decodedText.mediaType }
      : undefined;
  });
  const encoded = $derived(source === 'file' ? fileEncoded : encodedText);

  const problem = $derived.by((): string => {
    if (tooLong) {
      return t('base64.textTooLong', { max: MAX_TEXT_CHARS });
    }
    if (source === 'file') {
      return fileFailure;
    }
    return decodedText?.ok === false ? decodeErrorText(decodedText.error) : '';
  });

  const summary = $derived.by((): string => {
    if (encoded !== undefined && source === 'text') {
      return t('base64.announce.encoded', {
        bytes: new TextEncoder().encode(text).length,
        chars: encoded.length,
      });
    }
    if (decoded !== undefined && source === 'text') {
      return asText(decoded.bytes) === undefined
        ? t('base64.announce.decodedBinary', { bytes: decoded.bytes.length })
        : t('base64.announce.decodedText', { bytes: decoded.bytes.length });
    }
    return '';
  });

  // What is said waits for a pause in typing, so that a screen reader is not told about every key.
  $effect(() => {
    const message = problem === '' ? summary : '';
    const alert = problem;
    const timer = setTimeout(() => {
      if (source === 'text') {
        status = message;
      }
      failure = alert;
    }, STATUS_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  });

  // -- file: done in a worker, with progress and cancel ---------------------------------------

  async function runFile(
    chosen: File,
    way: Direction,
    encoding: EncodeOptions,
    mediaTypeToWrite: string | undefined,
  ): Promise<void> {
    controller?.abort();
    pool ??= createPool();
    const own = new AbortController();
    controller = own;
    fileEncoded = undefined;
    fileDecoded = undefined;
    fileFailure = '';
    status = '';
    done = 0;
    total = Math.max(chosen.size, 1);
    working = true;
    const limit = way === 'encode' ? MAX_FILE_BYTES : MAX_DECODE_FILE_BYTES;
    if (chosen.size > limit) {
      fileFailure = t('base64.fileTooBig', { size: formatSize(limit) });
      working = false;
      return;
    }
    const input: TaskInput =
      way === 'encode'
        ? {
            op: 'encode',
            file: chosen,
            options: encoding,
            ...(mediaTypeToWrite === undefined ? {} : { mediaType: mediaTypeToWrite }),
          }
        : { op: 'decode', file: chosen };
    try {
      const output = await pool.run(input, {
        signal: own.signal,
        onProgress: (progress) => {
          done = progress.completed;
          total = progress.total;
        },
      });
      if (controller !== own) {
        return;
      }
      if (!output.ok) {
        fileFailure = decodeErrorText(output.error);
      } else if (output.kind === 'encoded') {
        fileEncoded = output.text;
        status = t('base64.announce.encoded', { bytes: output.size, chars: output.text.length });
      } else {
        fileDecoded = { bytes: output.bytes, mediaType: output.mediaType };
        status =
          asText(output.bytes) === undefined
            ? t('base64.announce.decodedBinary', { bytes: output.bytes.length })
            : t('base64.announce.decodedText', { bytes: output.bytes.length });
      }
    } catch {
      if (own.signal.aborted) {
        if (controller === own) {
          status = t('base64.cancelled');
        }
      } else {
        fileFailure = t('base64.failed');
      }
    } finally {
      if (controller === own) {
        working = false;
      }
    }
  }

  // The file is converted again when what decides the result changes.
  $effect(() => {
    if (source !== 'file' || file === undefined) {
      return;
    }
    // What decides the result is read here, so that the effect runs again when it changes.
    void runFile(file, direction, options, dataType);
  });

  function onfiles(files: File[]): void {
    const [chosen] = files;
    if (chosen !== undefined) {
      typedType = undefined;
      file = chosen;
    }
  }

  function cancel(): void {
    controller?.abort();
  }

  function onsource(): void {
    status = '';
    failure = '';
    fileFailure = '';
  }

  function ondirection(): void {
    status = '';
    failure = '';
    controller?.abort();
    fileEncoded = undefined;
    fileDecoded = undefined;
    fileFailure = '';
  }

  // -- what is shown ----------------------------------------------------------------------------

  const decodedAsText = $derived(decoded === undefined ? undefined : asText(decoded.bytes));
  const shownEncoded = $derived(encoded === undefined ? undefined : encoded.slice(0, SHOWN_CHARS));
  const shownDecoded = $derived(decodedAsText?.slice(0, SHOWN_CHARS));
  const truncated = $derived(
    (encoded !== undefined && encoded.length > SHOWN_CHARS) ||
      (decodedAsText !== undefined && decodedAsText.length > SHOWN_CHARS),
  );
  const shownTotal = $derived((encoded ?? decodedAsText ?? '').length);

  function downloadDecoded(): void {
    if (decoded !== undefined) {
      const name = decodedFileName(decoded.mediaType, decodedAsText !== undefined);
      const type = downloadType(decoded.mediaType, decodedAsText !== undefined);
      saveBlob(name, new Blob([decoded.bytes as Uint8Array<ArrayBuffer>], { type }));
    }
  }
</script>

<ToolFrame id="base64">
  <div class="tool">
    <section class="block">
      <div class="pair">
        <Select
          label={t('base64.direction')}
          options={directionOptions}
          bind:value={direction}
          onchange={ondirection}
        />
        <Select
          label={t('base64.source')}
          options={sourceOptions}
          bind:value={source}
          onchange={onsource}
        />
      </div>

      {#if source === 'text'}
        <Textarea
          label={direction === 'encode' ? t('base64.textEncode') : t('base64.textDecode')}
          hint={direction === 'encode' ? t('base64.textEncodeHint') : t('base64.textDecodeHint')}
          bind:value={text}
          rows={8}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
        />
      {:else}
        <FileDrop
          mode="dispatch"
          rejectMessages={false}
          statusLabel=""
          dropLabel={direction === 'encode' ? t('base64.dropEncode') : t('base64.dropDecode')}
          buttonLabel={t('base64.choose')}
          multiple={false}
          disabled={working}
          {onfiles}
        />
        {#if file !== undefined}
          <p class="note">{file.name} · {formatSize(file.size)}</p>
        {/if}
        {#if working}
          <Progress
            hideLabel
            label={t('base64.working', { name: file?.name ?? '' })}
            value={done}
            max={total}
            valueText={`${formatSize(done)} / ${formatSize(total)}`}
          />
          <div>
            <Button variant="secondary" size="sm" onclick={cancel}>{t('base64.cancel')}</Button>
          </div>
        {/if}
      {/if}

      {#if direction === 'encode'}
        <div class="checks">
          <Checkbox label={t('base64.dataUri')} bind:checked={asUri} />
          {#if !asUri}
            <Checkbox label={t('base64.urlSafe')} bind:checked={urlSafe} />
            <Checkbox label={t('base64.padding')} bind:checked={padding} />
          {/if}
        </div>
        {#if asUri}
          <Input
            keepHint
            label={t('base64.mediaType')}
            hint={t('base64.mediaTypeHint')}
            bind:value={
              () => mediaType,
              (value: string) => {
                typedType = value;
              }
            }
            error={mediaProblem}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
          />
        {:else}
          <Select label={t('base64.lines')} options={lineOptions} bind:value={lines} />
        {/if}
      {/if}

      <ToolStatus message={status} />
      <ToolStatus kind="alert" message={failure} />
    </section>

    {#if shownEncoded !== undefined}
      <section class="block">
        <h2 class="heading">{t('base64.result')}</h2>
        <Textarea
          label={t('base64.result')}
          value={shownEncoded}
          readonly
          rows={8}
          spellcheck={false}
        />
        {#if truncated}
          <p class="note">{t('base64.truncated', { shown: SHOWN_CHARS, total: shownTotal })}</p>
        {/if}
        <div class="row">
          <CopyButton text={encoded ?? ''} label={t('base64.copy')} value={t('base64.copied')} />
          <Button
            variant="secondary"
            size="sm"
            onclick={() => {
              saveText('encoded.txt', encoded ?? '');
            }}>{t('base64.downloadText')}</Button
          >
        </div>
      </section>
    {/if}

    {#if decoded !== undefined}
      <section class="block">
        <h2 class="heading">{t('base64.result')}</h2>
        {#if shownDecoded !== undefined}
          <Textarea
            label={t('base64.resultText')}
            value={shownDecoded}
            readonly
            rows={8}
            spellcheck={false}
          />
          {#if truncated}
            <p class="note">{t('base64.truncated', { shown: SHOWN_CHARS, total: shownTotal })}</p>
          {/if}
        {:else}
          <p class="note">
            {t('base64.binary', { bytes: decoded.bytes.length, head: hexHead(decoded.bytes) })}
          </p>
        {/if}
        {#if decoded.mediaType !== undefined}
          <p class="note">{t('base64.mediaTypeFound', { type: decoded.mediaType })}</p>
        {/if}
        <div class="row">
          {#if decodedAsText !== undefined}
            <CopyButton text={decodedAsText} label={t('base64.copy')} value={t('base64.copied')} />
          {/if}
          <Button variant="secondary" size="sm" onclick={downloadDecoded}
            >{t('base64.downloadFile')}</Button
          >
        </div>
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

  .pair {
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

  .note {
    margin: 0;
    font: 13px/1.5 var(--mono);
    color: var(--mut);
    overflow-wrap: anywhere;
  }
</style>
