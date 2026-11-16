<script lang="ts">
  import { normaliseMax, progressPercent } from './progress.ts';

  interface Props {
    /** Accessible name: what is progressing. */
    label: string;
    /** Current value; leave unset for work of unknown length (indeterminate). */
    value?: number;
    max?: number;
    /** `warn` draws the amber bar (for example storage that is full). */
    tone?: 'default' | 'warn';
    /** Text alternative of the value, for example "3 of 12 files". */
    valueText?: string;
  }

  let { label, value, max = 100, tone = 'default', valueText }: Props = $props();

  const safeMax = $derived(normaliseMax(max));
  const percent = $derived(value === undefined ? undefined : progressPercent(value, max));
</script>

<div
  class="bar"
  class:warn={tone === 'warn'}
  class:indeterminate={percent === undefined}
  role="progressbar"
  aria-label={label}
  aria-valuemin="0"
  aria-valuemax={safeMax}
  aria-valuenow={percent === undefined ? undefined : (percent / 100) * safeMax}
  aria-valuetext={valueText}
>
  <i style:width={percent === undefined ? undefined : `${String(percent)}%`}></i>
</div>

<style>
  .bar {
    height: 8px;
    background: var(--line);
    position: relative;
    overflow: hidden;
  }

  i {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background: var(--pink);
  }

  .warn i {
    background: var(--amber);
  }

  /* Unknown length: pixel stripes that step along (static under reduced motion). */
  .indeterminate i {
    width: 100%;
    background-color: transparent;
    background-image: repeating-linear-gradient(90deg, var(--pink) 0 16px, transparent 16px 32px);
    background-size: 32px 100%;
    animation: slide 0.8s steps(4) infinite;
  }

  .indeterminate.warn i {
    background-image: repeating-linear-gradient(90deg, var(--amber) 0 16px, transparent 16px 32px);
  }

  @keyframes slide {
    to {
      background-position: 32px 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .indeterminate i {
      animation: none;
    }
  }

  @media (forced-colors: active) {
    .bar {
      border: 1px solid CanvasText;
    }

    i {
      background: Highlight;
    }

    .indeterminate i,
    .indeterminate.warn i {
      background-image: repeating-linear-gradient(90deg, Highlight 0 16px, transparent 16px 32px);
    }
  }
</style>
