<script lang="ts">
  import { Input, Select } from '@mozra-the-great/kern';
  import TextArea from '../../app/TextArea.svelte';
  import { t, type MessageKey } from '../../i18n/index.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import ToolStatus from '../../app/ToolStatus.svelte';
  import Button from '../../ui/Button.svelte';
  import {
    MAX_LENGTH,
    decodeText,
    encodeText,
    parseUrl,
    type EncodeMode,
    type ParsedUrl,
  } from './url.ts';

  const MODE_KEYS: Readonly<Record<EncodeMode, MessageKey>> = {
    component: 'url.mode.component',
    uri: 'url.mode.uri',
    form: 'url.mode.form',
  };

  const HINT_KEYS: Readonly<Record<EncodeMode, MessageKey>> = {
    component: 'url.mode.componentHint',
    uri: 'url.mode.uriHint',
    form: 'url.mode.formHint',
  };

  let text = $state('');
  let mode = $state<EncodeMode>('component');
  let converted = $state<string | undefined>(undefined);
  let status = $state('');
  let failure = $state('');
  let address = $state(t('url.example'));

  const modeOptions = $derived(
    (Object.keys(MODE_KEYS) as EncodeMode[]).map((value) => ({
      value,
      label: t(MODE_KEYS[value]),
    })),
  );
  const tooLong = $derived(text.length > MAX_LENGTH);
  const textProblem = $derived(tooLong ? t('url.tooLong', { max: MAX_LENGTH }) : '');

  function convert(direction: 'encode' | 'decode'): void {
    failure = '';
    if (tooLong) {
      converted = undefined;
      status = '';
      return;
    }
    if (direction === 'encode') {
      const result = encodeText(text, mode);
      if (result.ok) {
        converted = result.text;
        status = t('url.announce.encoded');
      } else {
        converted = undefined;
        status = '';
        failure = t('url.error.surrogate');
      }
      return;
    }
    const result = decodeText(text, mode);
    if (result.ok) {
      converted = result.text;
      status = t('url.announce.decoded');
    } else {
      converted = undefined;
      status = '';
      failure = t('url.error.malformed', { position: result.index + 1 });
    }
  }

  const parsed = $derived(parseUrl(address.length > MAX_LENGTH ? '' : address));
  const addressProblem = $derived.by((): string => {
    if (address.length > MAX_LENGTH) {
      return t('url.tooLong', { max: MAX_LENGTH });
    }
    return !parsed.ok && parsed.error === 'invalid' ? t('url.parse.invalid') : '';
  });
  const url = $derived<ParsedUrl | undefined>(parsed.ok ? parsed.url : undefined);

  const parts = $derived.by((): { label: string; value: string }[] => {
    if (url === undefined) {
      return [];
    }
    const rows: [MessageKey, string][] = [
      ['url.part.href', url.href],
      ['url.part.protocol', url.protocol],
      ['url.part.username', url.username],
      ['url.part.password', url.password],
      ['url.part.hostname', url.hostname],
      ['url.part.port', url.port],
      ['url.part.pathname', url.pathname],
      ['url.part.search', url.search],
      ['url.part.hash', url.hash],
      ['url.part.origin', url.origin],
    ];
    return rows
      .filter(([, value]) => value !== '')
      .map(([key, value]) => ({ label: t(key), value }));
  });

  let parseStatus = $state('');
  function announceParse(): void {
    parseStatus =
      url === undefined
        ? addressProblem
        : t('url.announce.parsed', { count: url.params.length, host: url.hostname });
  }
</script>

<ToolFrame id="url">
  <div class="tool">
    <section class="block">
      <h2 class="heading">{t('url.convert')}</h2>
      <TextArea
        label={t('url.text')}
        bind:value={text}
        error={textProblem}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
      />
      <Select
        label={t('url.mode')}
        options={modeOptions}
        bind:value={mode}
        hint={t(HINT_KEYS[mode])}
      />
      <div class="row">
        <Button
          onclick={() => {
            convert('encode');
          }}>{t('url.encode')}</Button
        >
        <Button
          variant="ghost"
          onclick={() => {
            convert('decode');
          }}>{t('url.decode')}</Button
        >
      </div>
      <ToolStatus message={status} />
      <ToolStatus kind="alert" message={failure} />
      {#if converted !== undefined}
        <TextArea label={t('url.result')} value={converted} readonly rows={4} />
        <div>
          <CopyButton text={converted} label={t('url.copy')} value={t('url.copiedValue')} />
        </div>
      {/if}
    </section>

    <section class="block">
      <h2 class="heading">{t('url.parse')}</h2>
      <Input
        keepHint
        label={t('url.address')}
        hint={t('url.addressHint')}
        bind:value={address}
        error={addressProblem}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        onchange={announceParse}
      />
      <ToolStatus message={parseStatus} />
      {#if url !== undefined}
        <table aria-label={t('url.parts.caption')}>
          <thead>
            <tr>
              <th scope="col">{t('url.col.part')}</th>
              <th scope="col">{t('url.col.value')}</th>
            </tr>
          </thead>
          <tbody>
            {#each parts as part (part.label)}
              <tr>
                <th scope="row">{part.label}</th>
                <td class="code">{part.value}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if url.params.length > 0}
          <h3 class="subheading">{t('url.params')}</h3>
          <table aria-label={t('url.params.caption')}>
            <thead>
              <tr>
                <th scope="col">{t('url.col.name')}</th>
                <th scope="col">{t('url.col.value')}</th>
              </tr>
            </thead>
            <tbody>
              {#each url.params as param, index (index)}
                <tr>
                  <td class="code">{param.name}</td>
                  <td class="code">{param.value === '' ? t('url.empty') : param.value}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
        <p class="note">{t('url.parse.note')}</p>
      {/if}
    </section>
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

  .subheading {
    margin: 0;
    font-size: 17px;
    font-weight: 500;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-12);
  }

  table {
    border-collapse: collapse;
    width: 100%;
    font: 14px var(--mono);
  }

  th,
  td {
    padding: var(--space-8) var(--space-12);
    border-bottom: 1px solid var(--line);
    text-align: left;
    font-weight: 400;
    vertical-align: top;
    overflow-wrap: anywhere;
  }

  thead th,
  tbody th {
    color: var(--mut);
  }

  .code {
    white-space: pre-wrap;
  }

  .note {
    margin: 0;
    font: 13px var(--mono);
    color: var(--mut);
  }
</style>
