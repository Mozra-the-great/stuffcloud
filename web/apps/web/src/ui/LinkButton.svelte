<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAnchorAttributes } from 'svelte/elements';
  import { buttonClasses, type ButtonSize, type ButtonVariant } from './button-classes.ts';
  import './button.css';

  interface Props extends Omit<HTMLAnchorAttributes, 'class' | 'children' | 'href'> {
    /** Required: a link without a target is not a link (use `Button` for actions). */
    href: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
    wide?: boolean;
    children: Snippet;
  }

  let {
    href,
    variant = 'primary',
    size = 'default',
    wide = false,
    children,
    ...rest
  }: Props = $props();
</script>

<a {...rest} {href} class={buttonClasses({ variant, size, wide })}>
  {@render children()}
</a>
