import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';
import { expectNoHorizontalScroll } from '../support/reflow.ts';

// JWT decoder in the built app, in Chromium and Firefox (T-22, #27). The accessibility gate (T-05,
// #13) applies to every tool: `a11y.check` after each state, a keyboard route for each action,
// results in live regions. Tokens and secrets are made in the page when the test runs (never
// written in a source) and registered with `net.watch`: the privacy check fails the test if a
// token or a key is sent anywhere.

interface Made {
  readonly token: string;
  readonly secret: string;
}

/** Signs an HS256 token with a random secret, in the browser, with WebCrypto. */
async function makeToken(page: Page, claims: Record<string, unknown>): Promise<Made> {
  return page.evaluate(async (payload) => {
    const encoder = new TextEncoder();
    const base64Url = (bytes: Uint8Array): string =>
      btoa(String.fromCharCode(...bytes))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
    const random = crypto.getRandomValues(new Uint8Array(24));
    const secret = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const input = `${base64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))}.${base64Url(
      encoder.encode(JSON.stringify(payload)),
    )}`;
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(input)));
    return { token: `${input}.${base64Url(signature)}`, secret };
  }, claims);
}

async function open(page: Page): Promise<void> {
  await page.goto('/tools/jwt');
  await expect(
    page.getByRole('heading', { level: 1, name: /^(JWT decoder|JWT-Decoder)$/ }),
  ).toBeVisible();
}

function tokenField(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: /^(Token)$/ });
}

function keyField(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('textbox', { name: /^(Key|Schlüssel)$/ });
}

function verified(page: Page): ReturnType<Page['locator']> {
  return page.locator('main .tool-status:not(.alert)');
}

function failed(page: Page): ReturnType<Page['locator']> {
  return page.locator('main .tool-status.alert');
}

test.describe('jwt', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await a11y.check(page, 'jwt');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await open(page);
    await expectKeyboardOnly(page, 'jwt');
  });

  test('decodes a token, shows its times, and says nothing is verified yet', async ({
    page,
    net,
    a11y,
  }) => {
    await open(page);
    // An hour more than three days, so that "in 3 days" still holds when the page reads it a moment later.
    const exp = Math.floor(Date.now() / 1000) + 3 * 86_400 + 3600;
    const { token, secret } = await makeToken(page, { sub: 'user-1', name: 'Ada', exp });
    net.watch(Buffer.from(token));
    net.watch(Buffer.from(secret));
    await tokenField(page).fill(token);
    await expect(page.getByText(/Decoded only, not verified\./)).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Header' }).locator('xpath=..').locator('pre'),
    ).toHaveText('{\n  "alg": "HS256",\n  "typ": "JWT"\n}');
    await expect(
      page.getByRole('heading', { level: 2, name: 'Payload' }).locator('xpath=..').locator('pre'),
    ).toContainText('"sub": "user-1"');
    const times = page.getByRole('table', { name: 'The time claims of the token' });
    await expect(times.getByRole('row', { name: /^Expires \(exp\)/ })).toContainText('in 3 days');
    await a11y.check(page, 'jwt: decoded');
  });

  test('checks the signature with the secret, and says when it does not match', async ({
    page,
    net,
    a11y,
  }) => {
    await open(page);
    const { token, secret } = await makeToken(page, { sub: 'user-1' });
    const other = (await makeToken(page, { sub: 'x' })).secret;
    net.watch(Buffer.from(token));
    net.watch(Buffer.from(secret));
    net.watch(Buffer.from(other));
    await tokenField(page).fill(token);
    await keyField(page).fill(secret);
    await page.getByRole('button', { name: 'Verify signature' }).focus();
    await page.keyboard.press('Enter');
    await expect(verified(page)).toHaveText('The signature is valid for this key.');
    await expect(page.getByText(/does not check exp, nbf, iss or aud/)).toBeVisible();
    await a11y.check(page, 'jwt: valid');
    await keyField(page).fill(other);
    await expect(verified(page)).toHaveText('');
    await page.getByRole('button', { name: 'Verify signature' }).click();
    await expect(failed(page)).toHaveText('The signature does NOT match this key.');
    await a11y.check(page, 'jwt: invalid');
  });

  test('checks an ES256 token with a public key made in the page', async ({ page, a11y }) => {
    await open(page);
    const made = await page.evaluate(async () => {
      const encoder = new TextEncoder();
      const base64Url = (bytes: Uint8Array): string =>
        btoa(String.fromCharCode(...bytes))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replace(/=+$/, '');
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
        'verify',
      ]);
      const input = `${base64Url(encoder.encode(JSON.stringify({ alg: 'ES256' })))}.${base64Url(
        encoder.encode(JSON.stringify({ sub: 'x' })),
      )}`;
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          encoder.encode(input),
        ),
      );
      const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
      return { token: `${input}.${base64Url(signature)}`, jwk: JSON.stringify(jwk) };
    });
    await tokenField(page).fill(made.token);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await keyField(page).fill(made.jwk);
    await page.getByRole('button', { name: 'Verify signature' }).click();
    await expect(verified(page)).toHaveText('The signature is valid for this key.');
    await a11y.check(page, 'jwt: ES256');
  });

  test('refuses a private key and a public key used as a secret', async ({ page, a11y }) => {
    await open(page);
    const made = await page.evaluate(async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
        'verify',
      ]);
      const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
      return { privateJwk: JSON.stringify(privateJwk) };
    });
    const forged = await makeToken(page, { sub: 'x' });
    // An ES256 header on a token signed some other way: the check goes by the header.
    const es = `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.${Buffer.from('signature').toString('base64url')}`;
    await tokenField(page).fill(es);
    await keyField(page).fill(made.privateJwk);
    await page.getByRole('button', { name: 'Verify signature' }).click();
    await expect(failed(page)).toContainText('This is a private key');
    await a11y.check(page, 'jwt: private key');
    await tokenField(page).fill(forged.token);
    await keyField(page).fill('-----BEGIN PUBLIC KEY-----\nAQID\n-----END PUBLIC KEY-----');
    await page.getByRole('button', { name: 'Verify signature' }).click();
    await expect(failed(page)).toContainText('wrong kind for HS256');
    await a11y.check(page, 'jwt: public key as secret');
  });

  test('warns about an unsecured token', async ({ page, a11y }) => {
    await open(page);
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.`;
    await tokenField(page).fill(none);
    await expect(page.getByText(/names the algorithm "none"/)).toBeVisible();
    await a11y.check(page, 'jwt: none');
  });

  test('says what is wrong with text that is no token', async ({ page, a11y }) => {
    await open(page);
    await tokenField(page).fill('not a token');
    await expect(tokenField(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(/A token has three parts/)).toBeVisible();
    await a11y.check(page, 'jwt: not a token');
  });

  test('fits in 320 pixels without a horizontal scroll bar', async ({ page, a11y }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    const { token } = await makeToken(page, { sub: 'user-1', exp: 4_102_444_800 });
    await tokenField(page).fill(token);
    await expect(page.getByRole('heading', { level: 2, name: 'Header' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await a11y.check(page, 'jwt: phone');
  });
});

test.describe('jwt in German', () => {
  test.use({ locale: 'de-DE' });

  test('shows the German texts and passes the gate', async ({ page, a11y }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'JWT-Decoder' })).toBeVisible();
    const { token } = await makeToken(page, { sub: 'x', exp: 1 });
    await page.getByRole('textbox', { name: 'Token' }).fill(token);
    await expect(page.getByText(/Nur dekodiert, nicht geprüft\./)).toBeVisible();
    await expect(
      page.getByRole('table', { name: 'Die Zeit-Claims des Tokens' }).getByRole('row').nth(1),
    ).toContainText('Abgelaufen');
    await a11y.check(page, 'jwt: German');
  });
});
