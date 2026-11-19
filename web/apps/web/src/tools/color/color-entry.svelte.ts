import { formatHex, parseColor, type ParsedColor, type Rgb } from './color.ts';

/**
 * A colour the visitor edits as text. `text` is what is in the field, whatever it says; `rgb` is the
 * last colour it described, so the results stay put while a half-typed value is not a colour yet.
 */
export class ColorEntry {
  #text = $state('');
  #rgb = $state<Rgb>({ r: 0, g: 0, b: 0 });
  #inGamut = $state(true);

  constructor(initial: string) {
    this.text = initial;
  }

  get text(): string {
    return this.#text;
  }

  set text(value: string) {
    this.#text = value;
    const parsed = parseColor(value);
    if (parsed.ok) {
      this.#rgb = parsed.rgb;
      this.#inGamut = parsed.inGamut;
    }
  }

  /** The colour of the text, or why it is none. */
  get result(): ParsedColor {
    return parseColor(this.#text);
  }

  /** The last valid colour. */
  get rgb(): Rgb {
    return this.#rgb;
  }

  /** False when the last valid colour was an OKLCH colour moved into the sRGB gamut. */
  get inGamut(): boolean {
    return this.#inGamut;
  }

  /** Replaces the text with the HEX of a colour. */
  setRgb(rgb: Rgb): void {
    this.text = formatHex(rgb);
  }
}
