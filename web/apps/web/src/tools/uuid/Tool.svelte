<script lang="ts">
  import { Input, Select, Button, Checkbox, Textarea, StatusMessage } from '@mozra-the-great/kern';
  import { t } from '../../i18n/index.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import DownloadButton from '../../app/DownloadButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import {
    DEFAULT_COUNT,
    MAX_COUNT,
    MIN_COUNT,
    Uuid7Generator,
    formatForDisplay,
    generateBatch,
    type UuidVersion,
  } from './uuid.ts';

  // One generator for the whole visit: version 7 UUIDs keep their order across the clicks.
  const generator = new Uuid7Generator();

  let version = $state<UuidVersion>('v4');
  let countText = $state(String(DEFAULT_COUNT));
  let uppercase = $state(false);
  let hyphens = $state(true);
  let status = $state('');
  let raw = $state<readonly string[]>([]);

  const count = $derived(/^\d{1,5}$/.test(countText.trim()) ? Number(countText.trim()) : NaN);
  const countProblem = $derived(
    Number.isInteger(count) && count >= MIN_COUNT && count <= MAX_COUNT
      ? ''
      : t('uuid.countError', { min: MIN_COUNT, max: MAX_COUNT }),
  );
  const text = $derived(
    raw.map((uuid) => formatForDisplay(uuid, { uppercase, hyphens })).join('\n'),
  );

  const versionOptions = $derived([
    { value: 'v4', label: t('uuid.version.v4') },
    { value: 'v7', label: t('uuid.version.v7') },
  ]);

  function make(announce: boolean): void {
    const result = generateBatch(version, count, generator);
    if (!result.ok) {
      raw = [];
      status = '';
      return;
    }
    raw = result.uuids;
    if (announce) {
      status = t(version === 'v7' ? 'uuid.announceV7' : 'uuid.announceV4', {
        count: result.uuids.length,
      });
    }
  }

  // New UUIDs when the version or the amount changes (`make` reads both; a click announces them too).
  $effect(() => {
    make(false);
  });

  // Not `bind:value`: on a number field Svelte binds a number (or null when it is empty).
  function onCount(event: Event & { currentTarget: HTMLInputElement }): void {
    countText = event.currentTarget.value;
  }
</script>

<ToolFrame id="uuid">
  <div class="tool">
    <section class="block">
      <Select label={t('uuid.version')} options={versionOptions} bind:value={version} />
      <Input
        keepHint
        type="number"
        inputmode="numeric"
        min={MIN_COUNT}
        max={MAX_COUNT}
        step={1}
        label={t('uuid.count')}
        hint={t('uuid.countHint', { min: MIN_COUNT, max: MAX_COUNT })}
        error={countProblem}
        value={countText}
        oninput={onCount}
      />
      <Checkbox label={t('uuid.uppercase')} bind:checked={uppercase} />
      <Checkbox label={t('uuid.hyphens')} bind:checked={hyphens} />
      <div class="actions">
        <Button
          onclick={() => {
            make(true);
          }}
          disabled={countProblem !== ''}>{t('uuid.generate')}</Button
        >
      </div>
      <StatusMessage data-tool-status tone="ok" message={status} />
    </section>

    <section class="block">
      <h2 class="heading">{t('uuid.result')}</h2>
      <Textarea
        label={t('uuid.list')}
        value={text}
        readonly
        rows={Math.min(Math.max(raw.length, 3), 14)}
        spellcheck={false}
      />
      <div class="actions">
        <CopyButton {text} label={t('uuid.copy')} value={t('uuid.copiedValue')} />
        <DownloadButton
          label={t('uuid.download')}
          name={`uuid-${version}.txt`}
          text={`${text}\n`}
          disabled={text === ''}
        />
      </div>
      <p class="note">{t(version === 'v7' ? 'uuid.noteV7' : 'uuid.noteV4')}</p>
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

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-12);
  }

  .note {
    margin: 0;
    font: 13px var(--mono);
    color: var(--mut);
  }
</style>
