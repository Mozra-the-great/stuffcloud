<script lang="ts">
  import type { HTMLSelectAttributes } from 'svelte/elements';
  import { describedBy, hasText } from './field-ids.ts';
  import './field.css';
  import type { SelectOption } from './types.ts';

  interface Props extends Omit<HTMLSelectAttributes, 'class' | 'value' | 'children'> {
    label: string;
    options: readonly SelectOption[];
    value?: string;
    hint?: string;
    error?: string;
  }

  let { label, options, value = $bindable(''), hint, error, id, ...rest }: Props = $props();

  const uid = $props.id();
  const selectId = $derived(id ?? `${uid}-select`);
  const hintId = $derived(`${uid}-hint`);
  const errorId = $derived(`${uid}-error`);
  const hasError = $derived(hasText(error));
  const hasHint = $derived(hasText(hint));
  const describedByIds = $derived(
    describedBy(hasError ? errorId : undefined, hasHint ? hintId : undefined),
  );
</script>

<div class="sc-fld">
  <label class="sc-fld__label" for={selectId}>{label}</label>
  <select
    {...rest}
    id={selectId}
    class="sc-field"
    bind:value
    aria-invalid={hasError ? 'true' : undefined}
    aria-describedby={describedByIds}
  >
    {#each options as option (option.value)}
      <option value={option.value} disabled={option.disabled}>{option.label}</option>
    {/each}
  </select>
  {#if hasHint}
    <p class="sc-fld__hint" id={hintId}>{hint}</p>
  {/if}
  {#if hasError}
    <p class="sc-fld__error" id={errorId}>{error}</p>
  {/if}
</div>
