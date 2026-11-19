<script lang="ts">
  import { t } from '../../i18n/index.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import ToolStatus from '../../app/ToolStatus.svelte';
  import Button from '../../ui/Button.svelte';
  import FileDropzone from '../../ui/FileDropzone.svelte';
  import Input from '../../ui/Input.svelte';
  import { ColorEntry } from './color-entry.svelte.ts';
  import ColorField from './ColorField.svelte';
  import {
    checkContrast,
    contrastRatio,
    formatAll,
    formatHex,
    formatNumber,
    formatRatio,
    type ContrastCheckId,
    type Rgb,
  } from './color.ts';
  import { ImageError, readPixels } from './image-pixels.ts';
  import { CHECK_KEYS, ERROR_KEYS } from './messages.ts';
  import {
    DEFAULT_COLORS,
    extractPalette,
    MAX_COLORS,
    MIN_COLORS,
    parseColorCount,
    type PaletteColor,
    type Pixels,
  } from './palette.ts';

  // The colour and its formats.
  const main = new ColorEntry('#3a7bd5');
  const formats = $derived(formatAll(main.rgb));

  // Contrast.
  const text = new ColorEntry('#1f2937');
  const background = new ColorEntry('#ffffff');
  const ratio = $derived(contrastRatio(text.rgb, background.rgb));
  const checks = $derived(checkContrast(ratio));

  // Palette from an image.
  let pixels = $state<Pixels | undefined>();
  let imageName = $state('');
  let countText = $state(String(DEFAULT_COLORS));
  const count = $derived(parseColorCount(countText));
  const palette = $derived<readonly PaletteColor[]>(
    pixels === undefined ? [] : extractPalette(pixels, count),
  );
  let reading = 0;

  // What the live regions say.
  let status = $state('');
  let problem = $state('');

  function result(pass: boolean): string {
    return pass ? t('color.contrast.pass') : t('color.contrast.fail');
  }

  /** The message for a text that is no colour; empty when it is one. */
  function problemOf(entry: ColorEntry): string {
    const parsed = entry.result;
    return parsed.ok ? '' : t(ERROR_KEYS[parsed.error]);
  }

  function announceColor(): void {
    status = main.result.ok
      ? t('color.announce.set', { hex: formatHex(main.rgb) })
      : problemOf(main);
  }

  function announceContrast(): void {
    const invalid = problemOf(text) || problemOf(background);
    if (invalid !== '') {
      status = invalid;
      return;
    }
    const passes = (id: ContrastCheckId): boolean => checks.some((c) => c.id === id && c.pass);
    status = t('color.announce.contrast', {
      ratio: formatRatio(ratio),
      aa: result(passes('aa-normal')),
      aaLarge: result(passes('aa-large')),
      aaa: result(passes('aaa-normal')),
    });
  }

  function useAs(target: ColorEntry): void {
    target.setRgb(main.rgb);
    announceContrast();
  }

  function swap(): void {
    const first: Rgb = text.rgb;
    text.setRgb(background.rgb);
    background.setRgb(first);
    announceContrast();
  }

  function useFromPalette(color: PaletteColor): void {
    main.setRgb(color.rgb);
    status = t('color.announce.set', { hex: formatHex(color.rgb) });
  }

  function announcePalette(colors: readonly PaletteColor[], name: string): void {
    status = t('color.palette.done', { count: colors.length, name });
  }

  /** The drop zone takes one file (`multiple` is off); the palette is made from that one. */
  function choose(files: File[]): void {
    files.slice(0, 1).forEach((file) => {
      void read(file);
    });
  }

  async function read(file: File): Promise<void> {
    reading += 1;
    const turn = reading;
    problem = '';
    status = t('color.palette.reading', { name: file.name });
    try {
      const read = await readPixels(file);
      if (turn !== reading) {
        return;
      }
      const colors = extractPalette(read, count);
      pixels = read;
      imageName = file.name;
      if (colors.length === 0) {
        problem = t('color.palette.empty');
        status = '';
      } else {
        announcePalette(colors, file.name);
      }
    } catch (error: unknown) {
      if (turn !== reading) {
        return;
      }
      pixels = undefined;
      status = '';
      problem =
        error instanceof ImageError && error.code === 'too-large'
          ? t('color.palette.tooLarge')
          : t('color.palette.unreadable');
    }
  }

  function rejected(): void {
    problem = t('color.palette.notImage');
  }

  // Not `bind:value`: on a number field Svelte binds a number (or null when it is empty).
  function onCount(event: Event & { currentTarget: HTMLInputElement }): void {
    countText = event.currentTarget.value;
  }

  function countCommitted(): void {
    if (palette.length > 0) {
      announcePalette(palette, imageName);
    }
  }
</script>

<ToolFrame id="color">
  <div class="tool">
    <section class="block">
      <ColorField
        entry={main}
        label={t('color.field.main')}
        pickerLabel={t('color.picker.main')}
        hint={t('color.field.hint')}
        oncommit={announceColor}
      />
      {#if !main.inGamut}
        <p class="note">{t('color.gamut')}</p>
      {/if}
      <ToolStatus message={status} />
      <ToolStatus message={problem} kind="alert" />
    </section>

    <section class="block">
      <h2 class="heading">{t('color.formats.title')}</h2>
      <div class="formats-layout">
        <div class="preview" style:background={formatHex(main.rgb)} aria-hidden="true"></div>
        <ul class="formats">
          {#each formats as format (format.format)}
            <li>
              <span class="format-name">{format.label}</span>
              <code class="format-value">{format.value}</code>
              <CopyButton
                text={format.value}
                label={t('color.formats.copy', { format: format.label })}
              />
            </li>
          {/each}
        </ul>
      </div>
    </section>

    <section class="block">
      <h2 class="heading">{t('color.contrast.title')}</h2>
      <div class="pair">
        <ColorField
          entry={text}
          label={t('color.contrast.text')}
          pickerLabel={t('color.picker.text')}
          oncommit={announceContrast}
        />
        <ColorField
          entry={background}
          label={t('color.contrast.background')}
          pickerLabel={t('color.picker.background')}
          oncommit={announceContrast}
        />
      </div>
      <div class="actions">
        <Button
          variant="ghost"
          size="compact"
          onclick={() => {
            useAs(text);
          }}>{t('color.contrast.useText')}</Button
        >
        <Button
          variant="ghost"
          size="compact"
          onclick={() => {
            useAs(background);
          }}>{t('color.contrast.useBackground')}</Button
        >
        <Button variant="ghost" size="compact" onclick={swap}>{t('color.contrast.swap')}</Button>
      </div>
      <!--
        A picture of the two colours, not text of the page: the sample is drawn as generated content
        (it is not in the accessibility tree, and axe does not judge it) because its contrast is
        whatever the visitor chose, which is exactly what the table next to it reports in words.
      -->
      <div
        class="sample"
        aria-hidden="true"
        data-sample={t('color.contrast.sample')}
        style:background={formatHex(background.rgb)}
        style:color={formatHex(text.rgb)}
      ></div>
      <p class="ratio">{t('color.contrast.ratio', { ratio: formatRatio(ratio) })}</p>
      <table>
        <caption>{t('color.contrast.table')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('color.contrast.level')}</th>
            <th scope="col">{t('color.contrast.needed')}</th>
            <th scope="col">{t('color.contrast.result')}</th>
          </tr>
        </thead>
        <tbody>
          {#each checks as check (check.id)}
            <tr>
              <th scope="row">{t(CHECK_KEYS[check.id])}</th>
              <td>{formatNumber(check.minimum, 1)}:1</td>
              <td class:pass={check.pass}>{result(check.pass)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="note">{t('color.contrast.large')}</p>
    </section>

    <section class="block">
      <h2 class="heading">{t('color.palette.title')}</h2>
      <FileDropzone
        hint={t('color.palette.hint')}
        buttonLabel={t('color.palette.choose')}
        accept="image/*"
        multiple={false}
        onfiles={choose}
        onreject={rejected}
      />
      <div class="count">
        <Input
          type="number"
          inputmode="numeric"
          min={MIN_COLORS}
          max={MAX_COLORS}
          step={1}
          label={t('color.palette.count')}
          hint={t('color.palette.countHint')}
          value={countText}
          oninput={onCount}
          onchange={countCommitted}
        />
      </div>
      {#if palette.length > 0}
        <ul class="palette" aria-label={t('color.palette.list', { name: imageName })}>
          {#each palette as color (formatHex(color.rgb))}
            <li>
              <span class="chip" style:background={formatHex(color.rgb)} aria-hidden="true"></span>
              <code class="format-value">{formatHex(color.rgb)}</code>
              <span class="share"
                >{t('color.palette.share', {
                  percent: Math.max(1, Math.round(color.share * 100)),
                })}</span
              >
              <Button
                variant="ghost"
                size="compact"
                aria-label={t('color.palette.use', { hex: formatHex(color.rgb) })}
                onclick={() => {
                  useFromPalette(color);
                }}>{t('color.palette.useShort')}</Button
              >
              <CopyButton
                text={formatHex(color.rgb)}
                label={t('color.formats.copy', { format: formatHex(color.rgb) })}
              />
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</ToolFrame>

<style>
  .tool {
    display: flex;
    flex-direction: column;
    gap: var(--space-40);
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-16);
    max-width: 760px;
  }

  .heading {
    margin: 0;
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.4px;
  }

  .note {
    margin: 0;
    font: 13px var(--mono);
    color: var(--mut);
  }

  .formats-layout {
    display: flex;
    gap: var(--space-20);
    align-items: stretch;
  }

  .preview {
    flex: none;
    width: 96px;
    border: 1px solid var(--line2);
  }

  .formats,
  .palette {
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--line);
  }

  .formats li,
  .palette li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-12);
    padding: var(--space-8) var(--space-12);
    border-bottom: 1px solid var(--line);
  }

  .formats li:last-child,
  .palette li:last-child {
    border-bottom: 0;
  }

  .format-name {
    width: 6ch;
    font: 12px var(--mono);
    letter-spacing: 1px;
    color: var(--mut);
  }

  .format-value {
    flex: 1;
    min-width: 12ch;
    font: 15px var(--mono);
    overflow-wrap: anywhere;
  }

  .pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: var(--space-20);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-12);
  }

  .sample {
    padding: var(--space-24);
    border: 1px solid var(--line2);
    font: 500 18px var(--sans);
  }

  .sample::before {
    content: attr(data-sample);
  }

  .ratio {
    margin: 0;
    font: 500 28px var(--mono);
  }

  table {
    border-collapse: collapse;
    width: 100%;
    font: 14px var(--mono);
  }

  caption {
    padding-bottom: var(--space-8);
    text-align: left;
    font: 12px var(--mono);
    letter-spacing: 1px;
    color: var(--mut);
    text-transform: uppercase;
  }

  th,
  td {
    padding: var(--space-8) var(--space-12);
    border-bottom: 1px solid var(--line);
    text-align: left;
    font-weight: 400;
  }

  thead th {
    color: var(--mut);
  }

  td.pass {
    color: var(--green);
  }

  td:not(.pass) {
    color: var(--pink2);
  }

  .count {
    max-width: 240px;
  }

  .chip {
    flex: none;
    width: 28px;
    height: 28px;
    border: 1px solid var(--line2);
  }

  .share {
    font: 13px var(--mono);
    color: var(--mut);
  }

  @media (max-width: 760px) {
    .formats-layout {
      flex-direction: column;
    }

    .preview {
      width: auto;
      height: 56px;
    }
  }

  @media (forced-colors: active) {
    .preview,
    .chip,
    .sample {
      forced-color-adjust: none;
    }
  }
</style>
