<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { buttonClasses, type ButtonSize, type ButtonVariant } from './button-classes.ts';
  import './button.css';

  interface Props extends Omit<HTMLButtonAttributes, 'class' | 'children'> {
    variant?: ButtonVariant;
    /** `icon` is a 48 px square: give it an accessible name with `aria-label`. */
    size?: ButtonSize;
    /** Label left, trailing content (arrow, icon) right. */
    wide?: boolean;
    children: Snippet;
  }

  let {
    variant = 'primary',
    size = 'default',
    wide = false,
    type = 'button',
    children,
    ...rest
  }: Props = $props();
</script>

<button {...rest} {type} class={buttonClasses({ variant, size, wide })}>
  {@render children()}
</button>
