<script lang="ts">
  import { Input, Button, Checkbox, StatusMessage } from '@mozra-the-great/kern';
  import { i18n, t, type MessageKey } from '../../i18n/index.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import {
    DEFAULT_LENGTH,
    MAX_LENGTH,
    generatePassword,
    selectedSets,
    strengthOf,
    type PasswordOptions,
    type Strength,
  } from './generate.ts';

  const STRENGTH_KEYS: Readonly<Record<Strength, MessageKey>> = {
    weak: 'password.strength.weak',
    fair: 'password.strength.fair',
    strong: 'password.strength.strong',
    'very-strong': 'password.strength.veryStrong',
  };

  let lengthText = $state(String(DEFAULT_LENGTH));
  let lower = $state(true);
  let upper = $state(true);
  let digits = $state(true);
  let symbols = $state(true);
  let excludeAmbiguous = $state(false);
  let status = $state('');
  // Counting up makes the password new without a change of the options.
  let round = $state(0);

  const length = $derived(/^\d{1,3}$/.test(lengthText.trim()) ? Number(lengthText.trim()) : NaN);
  const options = $derived<PasswordOptions>({
    length,
    lower,
    upper,
    digits,
    symbols,
    excludeAmbiguous,
  });
  const minimum = $derived(Math.max(4, selectedSets(options).length));

  // A new round gives a new password for the same options.
  const draw = $derived({ round, result: generatePassword(options) });
  const result = $derived(draw.result);

  const noSets = $derived(!result.ok && result.error.code === 'no-sets');
  const lengthError = $derived(
    !result.ok && result.error.code === 'length'
      ? t('password.lengthError', { min: result.error.min, max: result.error.max })
      : '',
  );
  const setsError = $derived(noSets ? t('password.noSets') : '');
  const bits = $derived(
    result.ok
      ? new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 1 }).format(result.entropyBits)
      : '',
  );
  const strength = $derived(result.ok ? t(STRENGTH_KEYS[strengthOf(result.entropyBits)]) : '');

  function again(): void {
    round += 1;
    status = result.ok ? t('password.announce', { bits, strength }) : '';
  }

  // Not `bind:value`: on a number field Svelte binds a number (or null when it is empty).
  function onLength(event: Event & { currentTarget: HTMLInputElement }): void {
    lengthText = event.currentTarget.value;
  }
</script>

<ToolFrame id="password">
  <div class="tool">
    <section class="block">
      <Input
        keepHint
        type="number"
        inputmode="numeric"
        min={minimum}
        max={MAX_LENGTH}
        step={1}
        label={t('password.length')}
        hint={t('password.lengthHint', { min: minimum, max: MAX_LENGTH })}
        error={lengthError}
        value={lengthText}
        oninput={onLength}
      />
      <fieldset class="kinds">
        <legend class="legend">{t('password.kinds')}</legend>
        <Checkbox label={t('password.lower')} bind:checked={lower} />
        <Checkbox label={t('password.upper')} bind:checked={upper} />
        <Checkbox label={t('password.digits')} bind:checked={digits} />
        <Checkbox label={t('password.symbols')} bind:checked={symbols} />
        <Checkbox label={t('password.ambiguous')} bind:checked={excludeAmbiguous} />
        {#if setsError !== ''}
          <p class="problem">{setsError}</p>
        {/if}
      </fieldset>
      <div>
        <Button onclick={again} disabled={!result.ok}>{t('password.generate')}</Button>
      </div>
      <StatusMessage data-tool-status message={status} />
    </section>

    {#if result.ok}
      <section class="block">
        <h2 class="heading">{t('password.result')}</h2>
        <div class="result">
          <code class="password">{result.password}</code>
          <CopyButton
            text={result.password}
            label={t('password.copy')}
            value={t('password.copiedValue')}
          />
        </div>
        <p class="meter">
          {t('password.entropy', { bits, strength, pool: result.poolSize })}
        </p>
        <p class="note">{t('password.note')}</p>
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

  .kinds {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    margin: 0;
    padding: 0;
    border: 0;
  }

  .legend {
    padding: 0 0 var(--space-8);
    font: 12px var(--mono);
    letter-spacing: 1px;
    color: var(--mut);
    text-transform: uppercase;
  }

  .problem {
    margin: 0;
    font: 13px var(--mono);
    color: var(--pink2);
  }

  .result {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-16);
  }

  .password {
    font: 500 22px/1.4 var(--mono);
    overflow-wrap: anywhere;
    word-break: break-all;
  }

  .meter {
    margin: 0;
    font: 500 16px/1.4 var(--mono);
  }

  .note {
    margin: 0;
    font: 13px var(--mono);
    color: var(--mut);
  }
</style>
