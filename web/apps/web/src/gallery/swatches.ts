/** Colour tokens the gallery shows (names from the generated tokens.css and theme.css). */
export const GALLERY_COLOURS: readonly string[] = [
  '--bg',
  '--fg',
  '--mut',
  '--line',
  '--line2',
  '--pink',
  '--pink2',
  '--lilac',
  '--violet',
  '--green',
  '--amber',
  '--bg-raised',
  '--bg-selected',
  '--bg-code',
];

export interface GalleryFont {
  readonly token: string;
  readonly sample: string;
}

/** Font tokens with a short specimen (a pixel font, a monospace font and a UI font). */
export const GALLERY_FONTS: readonly GalleryFont[] = [
  { token: '--pix', sample: 'stuffcloud 0123' },
  { token: '--mono', sample: 'stuffcloud 0123' },
  { token: '--sans', sample: 'stuffcloud 0123' },
];
