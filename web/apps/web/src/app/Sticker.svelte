<script lang="ts">
  import { CODE_ART, Mascot } from '@mozra-the-great/kern';
  import type { StickerName } from '@stuffcloud/tools';
  import { stickerArt, stickerScale, stickerUrl } from './stickers.ts';

  interface Props {
    name: StickerName;
    /** Wanted height in CSS pixels; the art is drawn at the whole-number scale that comes closest. */
    size?: number;
  }

  let { name, size = 48 }: Props = $props();

  const art = $derived(stickerArt(name));
  const scale = $derived(stickerScale(size, CODE_ART[art].rows));
</script>

<!--
  A decorative pixel sticker: kern's Mascot with code art, still (a sticker does not bob). The pixel
  grid is kern's (`CODE_ART`), the SVG file is the design's (`docs/design/prototypes`, ADR 0014), and
  every art pixel is a whole number of CSS pixels, so the edges stay crisp. Decorative: the tool's name
  sits right next to it.
-->
<Mascot name={art} src={stickerUrl(name)} {scale} animated={false} />
