<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { describedBy, hasText } from './field-ids.ts';
  import './field.css';

  interface Props extends Omit<HTMLInputAttributes, 'class' | 'value' | 'children'> {
    /** Visible label; every control has one (no placeholder-only fields). */
    label: string;
    value?: string;
    /** Helper text under the field. */
    hint?: string;
    /** Error text under the field; also marks the field invalid. */
    error?: string;
  }

  let { label, value = $bindable(''), hint, error, id, ...rest }: Props = $props();

  const uid = $props.id();
  const inputId = $derived(id ?? `${uid}-input`);
  const hintId = $derived(`${uid}-hint`);
  const errorId = $derived(`${uid}-error`);
  const hasError = $derived(hasText(error));
  const hasHint = $derived(hasText(hint));
  const describedByIds = $derived(
    describedBy(hasError ? errorId : undefined, hasHint ? hintId : undefined),
  );
</script>

<div class="sc-fld">
  <label class="sc-fld__label" for={inputId}>{label}</label>
  <input
    {...rest}
    id={inputId}
    class="sc-field"
    bind:value
    aria-invalid={hasError ? 'true' : undefined}
    aria-describedby={describedByIds}
  />
  {#if hasHint}
    <p class="sc-fld__hint" id={hintId}>{hint}</p>
  {/if}
  {#if hasError}
    <p class="sc-fld__error" id={errorId}>{error}</p>
  {/if}
</div>
