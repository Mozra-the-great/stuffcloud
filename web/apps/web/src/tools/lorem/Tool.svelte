<script lang="ts">
  import { t } from '../../i18n/index.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import { saveText } from '../../app/download.ts';
  import TextArea from '../../app/TextArea.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import ToolStatus from '../../app/ToolStatus.svelte';
  import Button from '../../ui/Button.svelte';
  import Checkbox from '../../ui/Checkbox.svelte';
  import Input from '../../ui/Input.svelte';
  import Select from '../../ui/Select.svelte';
  import { DEFAULT_COUNT, LIMITS, generateLorem, type LoremUnit } from './generate.ts';

  let unit = $state<LoremUnit>('paragraphs');
  let countText = $state(String(DEFAULT_COUNT.paragraphs));
  let classicOpening = $state(true);
  let status = $state('');
  // Counting up makes the text new without a change of the options.
  let round = $state(0);

  const count = $derived(/^\d{1,5}$/.test(countText.trim()) ? Number(countText.trim()) : NaN);
  const max = $derived(LIMITS[unit]);
  const draw = $derived({ round, result: generateLorem({ unit, count, classicOpening }) });
  const result = $derived(draw.result);
  const text = $derived(result.ok ? result.text : '');
  const countError = $derived(result.ok ? '' : t('lorem.countError', { max }));

  const unitOptions = $derived([
    { value: 'words', label: t('lorem.unit.words') },
    { value: 'sentences', label: t('lorem.unit.sentences') },
    { value: 'paragraphs', label: t('lorem.unit.paragraphs') },
  ]);

  function onUnit(event: Event & { currentTarget: HTMLSelectElement }): void {
    // A sensible amount for the new unit, so the text stays about as long as it was.
    const next = event.currentTarget.value as LoremUnit;
    countText = String(DEFAULT_COUNT[next]);
  }

  // Not `bind:value`: on a number field Svelte binds a number (or null when it is empty).
  function onCount(event: Event & { currentTarget: HTMLInputElement }): void {
    countText = event.currentTarget.value;
  }

  function again(): void {
    round += 1;
    status = result.ok ? t('lorem.announce') : '';
  }

  function download(): void {
    saveText('lorem-ipsum.txt', text);
  }
</script>

<ToolFrame id="lorem">
  <div class="tool">
    <section class="block">
      <Select label={t('lorem.unit')} options={unitOptions} bind:value={unit} onchange={onUnit} />
      <Input
        type="number"
        inputmode="numeric"
        min={1}
        {max}
        step={1}
        label={t('lorem.count')}
        hint={t('lorem.countHint', { max })}
        error={countError}
        value={countText}
        oninput={onCount}
      />
      <Checkbox label={t('lorem.classic')} bind:checked={classicOpening} />
      <div class="actions">
        <Button onclick={again} disabled={!result.ok}>{t('lorem.generate')}</Button>
      </div>
      <ToolStatus message={status} />
    </section>

    <section class="block">
      <h2 class="heading">{t('lorem.result')}</h2>
      <TextArea label={t('lorem.text')} value={text} readonly rows={10} />
      <div class="actions">
        <CopyButton {text} label={t('lorem.copy')} value={t('lorem.copiedValue')} />
        <Button variant="ghost" size="compact" disabled={text === ''} onclick={download}>
          {t('lorem.download')}
        </Button>
      </div>
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
</style>
