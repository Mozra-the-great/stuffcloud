<script lang="ts">
  import { Input } from '@mozra-the-great/kern';
  import { t } from '../../i18n/index.ts';
  import type { ColorEntry } from './color-entry.svelte.ts';
  import { formatHex, rgbFromPicker } from './color.ts';
  import { ERROR_KEYS } from './messages.ts';

  interface Props {
    entry: ColorEntry;
    /** Label of the text field. */
    label: string;
    /** Accessible name of the colour picker next to it. */
    pickerLabel: string;
    hint?: string;
    /** Called when the visitor has finished a change (Enter, leaving the field, closing the picker). */
    oncommit?: () => void;
  }

  let { entry, label, pickerLabel, hint, oncommit }: Props = $props();

  const result = $derived(entry.result);
  const error = $derived(result.ok ? undefined : t(ERROR_KEYS[result.error]));

  function pick(event: Event & { currentTarget: HTMLInputElement }): void {
    entry.setRgb(rgbFromPicker(event.currentTarget.value));
  }
</script>

<div class="color-field">
  <div class="text">
    <Input
      keepHint
      {label}
      bind:value={entry.text}
      hint={hint ?? ''}
      error={error ?? ''}
      spellcheck={false}
      autocomplete="off"
      autocapitalize="off"
      onchange={() => oncommit?.()}
    />
  </div>
  <input
    class="picker"
    type="color"
    aria-label={pickerLabel}
    value={formatHex(entry.rgb)}
    oninput={pick}
    onchange={() => oncommit?.()}
  />
</div>

<style>
  .color-field {
    display: flex;
    align-items: flex-start;
    gap: var(--space-12);
  }

  .text {
    flex: 1;
    min-width: 0;
  }

  /* Level with the text field: its label sits above it (about 28 px with the gap). */
  .picker {
    box-sizing: border-box;
    flex: none;
    width: var(--control-h);
    height: var(--control-h);
    margin-top: 28px;
    padding: 2px;
    background: transparent;
    border: 1px solid var(--field-border);
    border-radius: var(--radius);
    cursor: pointer;
  }

  @media (max-width: 760px) {
    .picker {
      width: var(--control-h-m);
      height: var(--control-h-m);
    }
  }

  @media (forced-colors: active) {
    .picker {
      border-color: FieldText;
    }
  }
</style>
