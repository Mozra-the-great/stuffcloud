<script lang="ts">
  import Checkbox from '../../ui/Checkbox.svelte';
  import TextArea from '../../app/TextArea.svelte';
  import { i18n, t, type MessageKey } from '../../i18n/index.ts';
  import CopyButton from '../../app/CopyButton.svelte';
  import ToolFrame from '../../app/ToolFrame.svelte';
  import ToolStatus from '../../app/ToolStatus.svelte';
  import Button from '../../ui/Button.svelte';
  import { relativeTime } from '../timestamp/relative.ts';
  import {
    MAX_KEY_LENGTH,
    MAX_TOKEN_LENGTH,
    SUPPORTED_ALGORITHMS,
    decodeToken,
    timeClaims,
    verifyToken,
    type DecodeErrorCode,
    type TimeClaimName,
    type TimeClaimState,
    type VerifyErrorCode,
    type VerifyResult,
  } from './jwt.ts';

  const DECODE_ERROR_KEYS: Readonly<Record<Exclude<DecodeErrorCode, 'empty'>, MessageKey>> = {
    'too-long': 'jwt.error.tooLong',
    encrypted: 'jwt.error.encrypted',
    parts: 'jwt.error.parts',
    base64: 'jwt.error.base64',
    utf8: 'jwt.error.utf8',
    'header-json': 'jwt.error.headerJson',
    'header-object': 'jwt.error.headerObject',
  };

  const VERIFY_ERROR_KEYS: Readonly<Record<VerifyErrorCode, MessageKey>> = {
    'no-algorithm': 'jwt.verify.noAlgorithm',
    unsecured: 'jwt.verify.unsecured',
    'unsupported-algorithm': 'jwt.verify.unsupportedAlgorithm',
    'unsupported-header': 'jwt.verify.unsupportedHeader',
    'no-signature': 'jwt.verify.noSignature',
    'bad-signature': 'jwt.verify.badSignature',
    'no-key': 'jwt.verify.noKey',
    'key-too-long': 'jwt.verify.keyTooLong',
    'key-kind': 'jwt.verify.keyKind',
    'key-private': 'jwt.verify.keyPrivate',
    'key-pem': 'jwt.verify.keyPem',
    'key-invalid': 'jwt.verify.keyInvalid',
  };

  const CLAIM_KEYS: Readonly<Record<TimeClaimName, MessageKey>> = {
    exp: 'jwt.claim.exp',
    nbf: 'jwt.claim.nbf',
    iat: 'jwt.claim.iat',
  };

  const STATE_KEYS: Readonly<Record<TimeClaimState, MessageKey>> = {
    expired: 'jwt.state.expired',
    'not-expired': 'jwt.state.notExpired',
    'not-yet-valid': 'jwt.state.notYetValid',
    'valid-since': 'jwt.state.validSince',
    issued: 'jwt.state.issued',
  };

  let tokenText = $state('');
  let keyText = $state('');
  let secretIsBase64 = $state(false);
  let outcome = $state<{ stamp: string; result: VerifyResult } | undefined>(undefined);
  let run = 0;

  const decoded = $derived(decodeToken(tokenText));
  const token = $derived(decoded.ok ? decoded.token : undefined);
  const tokenProblem = $derived(
    decoded.ok || decoded.error === 'empty'
      ? ''
      : t(DECODE_ERROR_KEYS[decoded.error], { max: MAX_TOKEN_LENGTH }),
  );

  const algorithm = $derived(token?.algorithm);
  const symmetric = $derived(algorithm?.startsWith('HS') === true);
  const unsecured = $derived(algorithm?.toLowerCase() === 'none');

  const times = $derived(timeClaims(token?.payload, Date.now()));
  const localFormat = $derived(
    new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'medium' }),
  );

  // A result belongs to the token and key it was made for; any edit hides it.
  const stamp = $derived(JSON.stringify([tokenText, keyText, secretIsBase64]));
  const shown = $derived(outcome?.stamp === stamp ? outcome.result : undefined);
  const keyProblem = $derived(
    keyText.length > MAX_KEY_LENGTH ? t('jwt.verify.keyTooLong', { max: MAX_KEY_LENGTH }) : '',
  );

  const verifiedText = $derived(shown?.ok === true && shown.valid ? t('jwt.verify.valid') : '');
  const failedText = $derived.by((): string => {
    if (shown === undefined) {
      return '';
    }
    if (shown.ok) {
      return shown.valid ? '' : t('jwt.verify.invalid');
    }
    return t(VERIFY_ERROR_KEYS[shown.error], {
      algorithm: shown.detail ?? algorithm ?? '',
      max: MAX_KEY_LENGTH,
    });
  });

  async function verify(): Promise<void> {
    if (token === undefined) {
      return;
    }
    run += 1;
    const own = run;
    const forStamp = stamp;
    const result = await verifyToken(token, keyText, secretIsBase64);
    if (own === run) {
      outcome = { stamp: forStamp, result };
    }
  }

  const keyHint = $derived(
    symmetric
      ? t('jwt.key.hintSecret')
      : algorithm === undefined || unsecured
        ? t('jwt.key.hint')
        : t('jwt.key.hintPublic'),
  );
</script>

<ToolFrame id="jwt">
  <div class="tool">
    <section class="block">
      <TextArea
        label={t('jwt.token')}
        hint={t('jwt.tokenHint')}
        bind:value={tokenText}
        error={tokenProblem}
        rows={6}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
      />
    </section>

    {#if token !== undefined}
      <section class="block">
        <p class="warning">{t('jwt.warning')}</p>
        {#if unsecured}
          <p class="warning">{t('jwt.unsecured')}</p>
        {/if}
      </section>

      <section class="block">
        <h2 class="heading">{t('jwt.header')}</h2>
        <pre class="json">{token.headerText}</pre>
        <div>
          <CopyButton
            text={token.headerText}
            label={t('jwt.copy.header')}
            value={t('jwt.header')}
          />
        </div>
      </section>

      <section class="block">
        <h2 class="heading">{t('jwt.payload')}</h2>
        {#if token.payload === undefined}
          <p class="note">{t('jwt.payload.notObject')}</p>
        {/if}
        <pre class="json">{token.payloadText}</pre>
        <div>
          <CopyButton
            text={token.payloadText}
            label={t('jwt.copy.payload')}
            value={t('jwt.payload')}
          />
        </div>
      </section>

      {#if times.claims.length > 0 || times.problems.length > 0}
        <section class="block">
          <h2 class="heading">{t('jwt.times')}</h2>
          {#if times.claims.length > 0}
            <table aria-label={t('jwt.times.caption')}>
              <thead>
                <tr>
                  <th scope="col">{t('jwt.col.claim')}</th>
                  <th scope="col">{t('jwt.col.time')}</th>
                  <th scope="col">{t('jwt.col.state')}</th>
                </tr>
              </thead>
              <tbody>
                {#each times.claims as claim (claim.name)}
                  <tr>
                    <th scope="row">{t(CLAIM_KEYS[claim.name])}</th>
                    <td class="code">
                      <span>{claim.iso}</span>
                      <span class="local">{localFormat.format(claim.seconds * 1000)}</span>
                    </td>
                    <td>
                      {t(STATE_KEYS[claim.state], {
                        relative: relativeTime(claim.seconds * 1000 - Date.now(), i18n.locale),
                      })}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
          {#each times.problems as problem (problem.name)}
            <p class="note">{t('jwt.times.problem', { claim: problem.name })}</p>
          {/each}
        </section>
      {/if}

      <section class="block">
        <h2 class="heading">{t('jwt.signature')}</h2>
        <p class="code signature">
          {token.signature === '' ? t('jwt.signature.none') : token.signature}
        </p>
        <p class="note">
          {algorithm === undefined ? t('jwt.algorithm.unknown') : t('jwt.algorithm', { algorithm })}
        </p>
      </section>

      <section class="block">
        <h2 class="heading">{t('jwt.verify')}</h2>
        <p class="note">{t('jwt.verify.intro', { algorithms: SUPPORTED_ALGORITHMS.join(', ') })}</p>
        <TextArea
          label={t('jwt.key')}
          hint={keyHint}
          bind:value={keyText}
          error={keyProblem}
          rows={5}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
        />
        {#if symmetric}
          <Checkbox label={t('jwt.key.base64')} bind:checked={secretIsBase64} />
        {/if}
        <div>
          <Button onclick={() => void verify()} disabled={keyProblem !== ''}
            >{t('jwt.verify.button')}</Button
          >
        </div>
        <ToolStatus message={verifiedText} />
        <ToolStatus kind="alert" message={failedText} />
        {#if verifiedText !== ''}
          <p class="note">{t('jwt.verify.validNote')}</p>
        {/if}
      </section>
    {/if}
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

  .warning {
    margin: 0;
    padding: var(--space-12) var(--space-16);
    border: 1px solid var(--pink2);
    border-radius: var(--radius);
    font: 15px/1.5 var(--mono);
  }

  .json {
    margin: 0;
    font: 14px/1.5 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .note {
    margin: 0;
    font: 13px/1.5 var(--mono);
    color: var(--mut);
  }

  .signature {
    margin: 0;
    font: 14px/1.5 var(--mono);
    overflow-wrap: anywhere;
  }

  .local {
    display: block;
    color: var(--mut);
  }

  table {
    border-collapse: collapse;
    width: 100%;
    font: 14px var(--mono);
  }

  th,
  td {
    padding: var(--space-8) var(--space-12);
    border-bottom: 1px solid var(--line);
    text-align: left;
    font-weight: 400;
    vertical-align: top;
    overflow-wrap: anywhere;
  }

  thead th,
  tbody th {
    color: var(--mut);
  }
</style>
