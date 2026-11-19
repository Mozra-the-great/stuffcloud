<script lang="ts">
  import type { StickerName } from '@stuffcloud/tools';
  import { stickerUrl } from './stickers.ts';

  // Candidate for kern (#121): a decorative pixel-art image at a whole-number scale.
  interface Props {
    name: StickerName;
    /** Height in CSS pixels; keep it a multiple of the art grid (12 rows) so the pixels stay crisp. */
    size?: number;
  }

  let { name, size = 48 }: Props = $props();
</script>

<!-- Decorative: the tool's name sits right next to it. -->
<img class="sticker" src={stickerUrl(name)} alt="" height={size} />

<style>
  .sticker {
    display: block;
    width: auto;
    flex: none;
    image-rendering: pixelated;
  }
</style>
