<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements';
  import { describedBy, hasText } from '../ui/field-ids.ts';
  import '../ui/field.css';

  interface Props extends Omit<HTMLTextareaAttributes, 'class' | 'value' | 'children'> {
    /** Visible label; every control has one (no placeholder-only fields). */
    label: string;
    value?: string;
    /** Helper text under the field. */
    hint?: string;
    /** Error text under the field; also marks the field invalid. */
    error?: string;
  }

  let { label, value = $bindable(''), hint, error, id, rows = 5, ...rest }: Props = $props();

  const uid = $props.id();
  const areaId = $derived(id ?? `${uid}-area`);
  const hintId = $derived(`${uid}-hint`);
  const errorId = $derived(`${uid}-error`);
  const hasError = $derived(hasText(error));
  const hasHint = $derived(hasText(hint));
  const describedByIds = $derived(
    describedBy(hasError ? errorId : undefined, hasHint ? hintId : undefined),
  );
</script>

<!--
  Candidate for kern (#121): a multi-line text field with the label, hint and error of Input (the
  base kit has no textarea yet). It reuses the shared field styles; until the freeze lifts it lives
  with the other tool-facing pieces in src/app.
-->
<div class="sc-fld">
  <label class="sc-fld__label" for={areaId}>{label}</label>
  <textarea
    {...rest}
    id={areaId}
    class="sc-field area"
    {rows}
    bind:value
    aria-invalid={hasError ? 'true' : undefined}
    aria-describedby={describedByIds}></textarea>
  {#if hasHint}
    <p class="sc-fld__hint" id={hintId}>{hint}</p>
  {/if}
  {#if hasError}
    <p class="sc-fld__error" id={errorId}>{error}</p>
  {/if}
</div>

<style>
  .area {
    padding: var(--space-12) var(--space-14);
    line-height: 1.5;
    resize: vertical;
    overflow-wrap: anywhere;
  }
</style>
