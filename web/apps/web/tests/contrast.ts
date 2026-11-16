export type Rgb = readonly [red: number, green: number, blue: number];

/** `#rrggbb` to `[r, g, b]` (0 to 255). */
export function parseHex(hex: string): Rgb {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    throw new Error(`not a six-digit hex colour: ${hex}`);
  }
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function linear(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2 relative luminance. */
export function relativeLuminance([red, green, blue]: Rgb): number {
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/** WCAG 2 contrast ratio between two `#rrggbb` colours (1 to 21, order does not matter). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(parseHex(a));
  const lb = relativeLuminance(parseHex(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
