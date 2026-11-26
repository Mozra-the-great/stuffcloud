<script lang="ts">
  import {
    Input,
    Select,
    Button,
    Checkbox,
    Textarea,
    saveBlob,
    saveText,
  } from '@mozra-the-great/kern';
  import { t, type MessageKey } from '../../i18n/index.ts';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import ToolStatus from '../../app/ToolStatus.svelte';
  import { ECC_LEVELS, buildQr, type QrResult } from './check.ts';
  import type { Ecc } from './matrix.ts';
  import {
    contactPayload,
    textPayload,
    wifiPayload,
    type PayloadError,
    type PayloadKind,
    type PayloadResult,
    type WifiSecurity,
  } from './payload.ts';
  import { encodePng } from './png.ts';
  import { rasterise } from './render.ts';
  import type { QrStyle } from './scene.ts';

  /** Typing waits this long for a pause before the code is made and scanned. */
  const DEBOUNCE_MS = 200;
  const SIZES = [512, 1024, 2048] as const;

  const ERROR_KEYS: Readonly<Record<Exclude<PayloadError['code'], 'ssid-length'>, MessageKey>> = {
    empty: 'qr.need.text',
    ssid: 'qr.need.ssid',
    password: 'qr.need.password',
    contact: 'qr.need.contact',
  };

  const ECC_KEYS: Readonly<Record<Ecc, MessageKey>> = {
    H: 'qr.ecc.H',
    Q: 'qr.ecc.Q',
    M: 'qr.ecc.M',
    L: 'qr.ecc.L',
  };

  function describe(error: PayloadError): string {
    return error.code === 'ssid-length'
      ? t('qr.ssidLength', { max: error.max })
      : t(ERROR_KEYS[error.code]);
  }

  let kind = $state<PayloadKind>('text');
  let text = $state('');
  let ssid = $state('');
  let wifiPassword = $state('');
  let security = $state<WifiSecurity>('WPA');
  let hidden = $state(false);
  let firstName = $state('');
  let lastName = $state('');
  let organisation = $state('');
  let phone = $state('');
  let email = $state('');
  let website = $state('');
  let style = $state<QrStyle>('stuffcloud');
  let ecc = $state<Ecc>('H');
  let size = $state('1024');

  let built = $state<{ readonly text: string; readonly result: QrResult } | undefined>(undefined);
  let status = $state('');
  let failure = $state('');

  const payload = $derived.by((): PayloadResult => {
    switch (kind) {
      case 'text':
        return textPayload(text);
      case 'wifi':
        return wifiPayload({ ssid, password: wifiPassword, security, hidden });
      case 'contact':
        return contactPayload({ firstName, lastName, organisation, phone, email, website });
    }
  });

  // The code is made when typing pauses; the preview and the readable content always belong together.
  $effect(() => {
    if (!payload.ok) {
      built = undefined;
      status = '';
      failure = '';
      return;
    }
    const content = payload.text;
    const requested = { style, ecc };
    const timer = setTimeout(() => {
      const result = buildQr(content, requested);
      built = { text: content, result };
      if (result.ok) {
        failure = '';
        status =
          result.code.fallback === 'scan'
            ? t('qr.fellBackScan')
            : result.code.fallback === 'capacity'
              ? t('qr.fellBackCapacity')
              : t('qr.ready');
      } else {
        status = '';
        failure = t(result.error === 'scan-failed' ? 'qr.scanFailed' : 'qr.tooLong');
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  });

  const code = $derived(built?.result.ok === true ? built.result.code : undefined);

  // The preview is the SVG file itself, as an object URL of this browser that is given back when the
  // picture changes or the page goes away (no request is made for it).
  let previewUrl = $state('');
  $effect(() => {
    if (code === undefined) {
      previewUrl = '';
      return;
    }
    const url = URL.createObjectURL(new Blob([code.svg], { type: 'image/svg+xml' }));
    previewUrl = url;
    return () => {
      URL.revokeObjectURL(url);
    };
  });
  const fallback = $derived(code?.fallback);
  const problem = $derived(payload.ok ? '' : describe(payload.error));
  // Only a name that is too long is a mistake in the field; the rest is "not filled in yet".
  const ssidError = $derived(
    kind === 'wifi' && !payload.ok && payload.error.code === 'ssid-length' ? problem : '',
  );

  const kindOptions = $derived([
    { value: 'text', label: t('qr.kind.text') },
    { value: 'wifi', label: t('qr.kind.wifi') },
    { value: 'contact', label: t('qr.kind.contact') },
  ]);
  const securityOptions = $derived([
    { value: 'WPA', label: t('qr.security.wpa') },
    { value: 'WEP', label: t('qr.security.wep') },
    { value: 'nopass', label: t('qr.security.none') },
  ]);
  const styleOptions = $derived([
    { value: 'stuffcloud', label: t('qr.style.stuffcloud') },
    { value: 'raw', label: t('qr.style.raw') },
  ]);
  const sizeOptions = $derived(SIZES.map((side) => ({ value: String(side), label: `${side} px` })));
  const eccOptions = $derived(
    ECC_LEVELS.map((level) => ({ value: level, label: t(ECC_KEYS[level]) })),
  );

  async function downloadPng(): Promise<void> {
    if (code === undefined) {
      return;
    }
    const side = Number(size);
    const scale = Math.max(1, Math.floor(side / code.scene.side));
    const bytes = await encodePng(
      rasterise(code.scene, scale, Math.max(side, code.scene.side * scale)),
    );
    const saved = saveBlob('qr-code.png', new Blob([bytes], { type: 'image/png' }));
    status = saved.ok ? t('qr.savedPng', { size: side }) : t('tool.downloadFailed');
  }

  function downloadSvg(): void {
    if (code === undefined) {
      return;
    }
    const saved = saveText('qr-code.svg', code.svg, 'image/svg+xml');
    status = saved.ok ? t('qr.savedSvg') : t('tool.downloadFailed');
  }
</script>

<ToolFrame id="qr">
  <div class="tool">
    <section class="block">
      <h2 class="heading">{t('qr.content')}</h2>
      <Select label={t('qr.kind')} options={kindOptions} bind:value={kind} />
      {#if kind === 'text'}
        <Textarea
          label={t('qr.text')}
          hint={t('qr.textHint')}
          bind:value={text}
          rows={5}
          spellcheck={false}
        />
      {:else if kind === 'wifi'}
        <Input label={t('qr.ssid')} bind:value={ssid} error={ssidError} autocomplete="off" />
        <Select label={t('qr.security')} options={securityOptions} bind:value={security} />
        {#if security !== 'nopass'}
          <Input
            label={t('qr.wifiPassword')}
            bind:value={wifiPassword}
            autocomplete="off"
            spellcheck={false}
          />
        {/if}
        <Checkbox label={t('qr.hidden')} bind:checked={hidden} />
      {:else}
        <Input label={t('qr.firstName')} bind:value={firstName} autocomplete="off" />
        <Input label={t('qr.lastName')} bind:value={lastName} autocomplete="off" />
        <Input label={t('qr.organisation')} bind:value={organisation} autocomplete="off" />
        <Input label={t('qr.phone')} type="tel" bind:value={phone} autocomplete="off" />
        <Input label={t('qr.email')} type="email" bind:value={email} autocomplete="off" />
        <Input label={t('qr.website')} type="url" bind:value={website} autocomplete="off" />
      {/if}
    </section>

    <section class="block">
      <h2 class="heading">{t('qr.options')}</h2>
      <Select label={t('qr.style')} options={styleOptions} bind:value={style} />
      {#if style === 'stuffcloud'}
        <Select
          label={t('qr.ecc')}
          options={eccOptions}
          value="H"
          disabled
          hint={t('qr.eccFixed')}
        />
      {:else}
        <Select label={t('qr.ecc')} options={eccOptions} bind:value={ecc} />
      {/if}
      <Select label={t('qr.size')} options={sizeOptions} bind:value={size} />
    </section>

    <section class="block">
      <h2 class="heading">{t('qr.result')}</h2>
      {#if code !== undefined && built !== undefined && previewUrl !== ''}
        <img
          class="preview"
          src={previewUrl}
          alt={t('qr.alt')}
          aria-describedby="qr-content"
          width="280"
          height="280"
        />
        <p class="scan">{t('qr.scanPassed')}</p>
        {#if fallback !== undefined}
          <p class="note">
            {fallback === 'scan' ? t('qr.fellBackScan') : t('qr.fellBackCapacity')}
          </p>
        {/if}
        <div class="actions">
          <Button
            onclick={() => {
              void downloadPng();
            }}>{t('qr.downloadPng')}</Button
          >
          <Button variant="secondary" onclick={downloadSvg}>{t('qr.downloadSvg')}</Button>
        </div>
        <div class="encoded" role="group" aria-labelledby="qr-content-label">
          <p class="label" id="qr-content-label">{t('qr.encoded')}</p>
          <pre id="qr-content" class="payload">{built.text}</pre>
        </div>
      {:else if problem !== ''}
        <p class="note">{problem}</p>
      {/if}
      <ToolStatus message={status} />
      <ToolStatus kind="alert" message={failure} />
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

  .preview {
    width: min(100%, 280px);
    height: auto;
    aspect-ratio: 1;
    border: 1px solid var(--line);
    image-rendering: pixelated;
    background: #ffffff;
  }

  .scan {
    margin: 0;
    font: 14px/1.5 var(--mono);
    color: var(--green);
  }

  .note {
    margin: 0;
    font: 13px var(--mono);
    color: var(--mut);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-12);
  }

  .label {
    margin: 0 0 var(--space-8);
    font: 12px var(--mono);
    letter-spacing: 1px;
    color: var(--mut);
    text-transform: uppercase;
  }

  .payload {
    margin: 0;
    padding: var(--space-12) var(--space-14);
    border: 1px solid var(--line);
    font: 14px/1.5 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
