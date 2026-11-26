/** Colour tokens the gallery shows: kern's Code theme (`--k-*`) and the one app-local token. */
export const GALLERY_COLOURS: readonly string[] = [
  '--k-bg',
  '--k-fg',
  '--k-fg-muted',
  '--k-line',
  '--k-line-strong',
  '--k-border',
  '--k-accent',
  '--k-danger',
  '--k-link',
  '--sc-stage',
  '--k-ok',
  '--k-warn',
  '--k-bg-raised',
  '--k-surface-selected',
  '--k-bg-code',
];

export interface GalleryFont {
  readonly token: string;
  readonly sample: string;
}

/** Font tokens with a short specimen (a pixel font, a monospace font and a UI font). */
export const GALLERY_FONTS: readonly GalleryFont[] = [
  { token: '--k-font-display', sample: 'stuffcloud 0123' },
  { token: '--k-font-mono', sample: 'stuffcloud 0123' },
  { token: '--k-font-sans', sample: 'stuffcloud 0123' },
];
