<script lang="ts">
  import { drawThumb } from './thumb-draw.ts';
  import type { ThumbBitmap } from './types.ts';

  interface Props {
    /** The page picture; `undefined` while it is being drawn (or when it could not be). */
    bitmap: ThumbBitmap | undefined;
    /** Clockwise degrees the visitor turned the page by. */
    turn?: number;
  }

  let { bitmap, turn = 0 }: Props = $props();

  let canvas: HTMLCanvasElement | undefined = $state();

  $effect(() => {
    if (canvas !== undefined && bitmap !== undefined) {
      drawThumb(canvas, bitmap, turn);
    }
  });
</script>

<!--
  The picture of one page. App-local: candidate for kern (#121) only together with PageGrid; it is
  decorative (the page's name is on the option that holds it), so it is hidden from assistive tech.
-->
{#if bitmap === undefined}
  <span class="blank" aria-hidden="true"></span>
{:else}
  <canvas bind:this={canvas} aria-hidden="true"></canvas>
{/if}

<style>
  canvas,
  .blank {
    display: block;
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    background: #fff;
  }

  .blank {
    width: 70%;
    aspect-ratio: 210 / 297;
    background: var(--line);
  }

  @media (forced-colors: active) {
    .blank {
      border: 1px solid CanvasText;
    }
  }
</style>
