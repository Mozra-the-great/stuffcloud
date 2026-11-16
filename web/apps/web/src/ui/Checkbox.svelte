<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';

  interface Props extends Omit<HTMLInputAttributes, 'class' | 'type' | 'checked' | 'children'> {
    label: string;
    checked?: boolean;
  }

  let { label, checked = $bindable(false), ...rest }: Props = $props();
</script>

<label class="toggle">
  <input {...rest} type="checkbox" bind:checked />
  <span>{label}</span>
</label>

<style>
  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-14);
    min-height: var(--target-icon);
    font-size: 15px;
    cursor: pointer;
  }

  input {
    width: 22px;
    height: 22px;
    margin: 0;
    flex: none;
    accent-color: var(--pink);
    cursor: inherit;
  }

  .toggle:has(input:disabled) {
    color: var(--fg-disabled);
    cursor: not-allowed;
  }
</style>
