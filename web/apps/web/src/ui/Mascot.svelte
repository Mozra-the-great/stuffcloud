<script lang="ts">
  import { MASCOTS, mascotSize, normaliseScale, type MascotName } from './mascots.ts';

  interface Props {
    name: MascotName;
    /** Whole CSS pixels per art pixel (fractions are cut off, minimum 1). */
    scale?: number;
    /** Scale on phones (max-width 760px); defaults to `scale`. */
    compactScale?: number;
    /** `false` shows the still pose only. Reduced-motion users always get the still pose. */
    animated?: boolean;
    /** Text alternative; leave unset for the usual decorative mascot (hidden from assistive tech). */
    label?: string;
  }

  let { name, scale = 8, compactScale, animated = true, label }: Props = $props();

  const art = $derived(MASCOTS[name]);
  const factor = $derived(normaliseScale(scale));
  const compactFactor = $derived(
    compactScale === undefined ? factor : normaliseScale(compactScale),
  );
  // Intrinsic size: reserves the box before any CSS or image arrives (no layout shift).
  const size = $derived(mascotSize(art, factor));

  let host: HTMLSpanElement | undefined = $state();
  let inView = $state(true);
  let pageVisible = $state(true);

  // Hidden tab: stop the idle motion (the animation clock must not run for nobody).
  $effect(() => {
    if (!animated) {
      return;
    }
    const sync = (): void => {
      pageVisible = document.visibilityState !== 'hidden';
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return (): void => {
      document.removeEventListener('visibilitychange', sync);
    };
  });

  // Off-screen: pause while the mascot is outside the viewport. One observer callback per
  // crossing, nothing per frame; without IntersectionObserver the mascot simply keeps running.
  $effect(() => {
    if (!animated || host === undefined || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const latest = entries.at(-1);
      if (latest !== undefined) {
        inView = latest.isIntersecting;
      }
    });
    observer.observe(host);
    return (): void => {
      observer.disconnect();
    };
  });

  const motion = $derived(!animated ? 'still' : inView && pageVisible ? 'running' : 'paused');
</script>

<span
  bind:this={host}
  class="mascot"
  data-mascot={name}
  data-motion={motion}
  style:--cols={art.cols}
  style:--rows={art.rows}
  style:--scale={factor}
  style:--scale-compact={compactFactor}
>
  <img
    src={art.url}
    alt={label ?? ''}
    aria-hidden={label === undefined ? 'true' : undefined}
    width={size.width}
    height={size.height}
    decoding="async"
    draggable="false"
  />
</span>

<style>
  .mascot {
    display: inline-block;
    flex: none;
    width: calc(var(--cols) * var(--scale) * 1px);
    height: calc(var(--rows) * var(--scale) * 1px);
    line-height: 0;
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    user-select: none;
  }

  /* Two poses, switched in one step (design reference). A transform animation runs without
     layout or paint work and never moves anything else on the page. */
  [data-motion='running'] img,
  [data-motion='paused'] img {
    animation: bob 1.2s steps(1) infinite;
  }

  [data-motion='paused'] img {
    animation-play-state: paused;
  }

  @keyframes bob {
    0%,
    49% {
      transform: translateY(0);
    }

    50%,
    100% {
      transform: translateY(-4px);
    }
  }

  @media (max-width: 760px) {
    .mascot {
      width: calc(var(--cols) * var(--scale-compact) * 1px);
      height: calc(var(--rows) * var(--scale-compact) * 1px);
    }
  }

  /* Everything stops under prefers-reduced-motion (design README, WCAG 2.3.3): the still pose. */
  @media (prefers-reduced-motion: reduce) {
    [data-motion] img {
      animation: none;
    }
  }
</style>
