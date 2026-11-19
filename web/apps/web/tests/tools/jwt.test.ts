import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { i18n } from '../../src/i18n/index.ts';
import manifest from '../../src/tools/jwt/manifest.ts';
import { toaster } from '../../src/ui/toast.svelte.ts';
import { openTool } from '../tool-helpers.ts';
import {
  b64url,
  ecKeys,
  ecToken,
  hmacToken,
  randomSecret,
  signingInput,
  tamperSignature,
} from './jwt-helpers.ts';

type User = ReturnType<typeof userEvent.setup>;

/** Monday 2026-06-01, 10:00 UTC. */
const NOW = Date.UTC(2026, 5, 1, 10, 0, 0);
const SECONDS = NOW / 1000;

const logs = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

const consoleSpies: MockInstance[] = [];

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  consoleSpies.length = 0;
  for (const method of logs) {
    consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
  }
});

afterEach(() => {
  toaster.clear();
  vi.restoreAllMocks();
  i18n.setLocale('en');
});

function tokenField(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Token' });
}

function keyField(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Key' });
}

async function paste(user: User, field: HTMLElement, value: string): Promise<void> {
  await user.clear(field);
  await user.click(field);
  if (value !== '') {
    await user.paste(value);
  }
}

function pre(heading: string): string {
  const section = screen.getByRole('heading', { level: 2, name: heading }).closest('section');
  return section?.querySelector('pre')?.textContent ?? '';
}

function alertText(): string {
  return document.querySelector('main .tool-status.alert')?.textContent ?? '';
}

function statusText(): string {
  return [...document.querySelectorAll('main .tool-status:not(.alert)')]
    .map((region) => region.textContent.trim())
    .join('');
}

function timeRows(name = 'The time claims of the token'): string[][] {
  return within(screen.getByRole('table', { name }))
    .getAllByRole('row')
    .slice(1)
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent.trim()));
}

describe('jwt', () => {
  it('keeps the privacy promise in its manifest', () => {
    expect(manifest.fileContent).toBe('stays-in-browser');
    expect(manifest.runsIn).toBe('client');
  });

  it('opens at /tools/jwt with one heading and is found by search', async () => {
    const view = await openTool(manifest);
    expect(view.path).toBe('/tools/jwt');
    expect(view.headings).toEqual(['JWT decoder']);
    expect(view.searchHits('json web token')).toEqual(['jwt']);
    expect(view.searchHits('bearer')).toEqual(['jwt']);
  });

  it('shows only the field until a token is pasted', async () => {
    await openTool(manifest);
    expect(tokenField().value).toBe('');
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(document.querySelector('.sc-fld__error')).toBeNull();
  });
});

describe('decoding', () => {
  let user: User;
  const secret = randomSecret();
  const claims = { sub: 'user-1', name: 'Ada', exp: SECONDS + 3 * 86_400, iat: SECONDS - 60 };

  beforeEach(async () => {
    user = userEvent.setup();
    await openTool(manifest);
  });

  it('shows header, payload, times and signature, with the warning that nothing is verified', async () => {
    const token = hmacToken('HS256', secret, claims);
    await paste(user, tokenField(), token);
    expect(screen.getByText(/Decoded only, not verified\./)).toBeTruthy();
    expect(pre('Header')).toBe('{\n  "alg": "HS256",\n  "typ": "JWT"\n}');
    expect(pre('Payload')).toBe(JSON.stringify(claims, null, 2));
    expect(timeRows()).toEqual([
      ['Expires (exp)', expect.stringContaining('2026-06-04T10:00:00.000Z'), 'Expires in 3 days'],
      [
        'Issued at (iat)',
        expect.stringContaining('2026-06-01T09:59:00.000Z'),
        'Issued 1 minute ago',
      ],
    ]);
    expect(screen.getByText(token.split('.')[2] ?? '')).toBeTruthy();
    expect(screen.getByText('Algorithm in the header: HS256')).toBeTruthy();
  });

  it('says a token has expired, or is not valid yet', async () => {
    await paste(
      user,
      tokenField(),
      hmacToken('HS256', secret, { exp: SECONDS - 2 * 3600, nbf: SECONDS + 3600 }),
    );
    expect(timeRows().map((row) => row[2])).toEqual([
      'Expired 2 hours ago',
      'Not valid yet: valid in 1 hour',
    ]);
    await paste(user, tokenField(), hmacToken('HS256', secret, { nbf: SECONDS - 86_400 }));
    expect(timeRows().map((row) => row[2])).toEqual(['Valid since yesterday']);
  });

  it('points out a time claim that is not a time', async () => {
    await paste(user, tokenField(), hmacToken('HS256', secret, { exp: 'tomorrow' }));
    expect(screen.queryByRole('table', { name: 'The time claims of the token' })).toBeNull();
    expect(screen.getByText(/"exp" is not a time/)).toBeTruthy();
  });

  it('shows no times section for a token without time claims', async () => {
    await paste(user, tokenField(), hmacToken('HS256', secret, { sub: 'x' }));
    expect(screen.queryByRole('heading', { level: 2, name: 'Times' })).toBeNull();
  });

  it('warns that an unsecured token proves nothing, and has no signature to show', async () => {
    await paste(user, tokenField(), `${signingInput({ alg: 'none' }, { sub: 'x' })}.`);
    expect(screen.getByText(/names the algorithm "none"/)).toBeTruthy();
    expect(screen.getByText('This token has no signature.')).toBeTruthy();
  });

  it('shows a payload that is not an object as it is, and a header without algorithm', async () => {
    await paste(user, tokenField(), `${signingInput({ typ: 'JWT' }, 'plain text')}.${b64url('x')}`);
    expect(
      screen.getByText('The payload is not a JSON object, so it is shown as it is.'),
    ).toBeTruthy();
    expect(pre('Payload')).toBe('plain text');
    expect(screen.getByText('The header names no algorithm (alg).')).toBeTruthy();
  });

  it('marks something that is not a token, with the reason', async () => {
    await paste(user, tokenField(), 'not a token');
    expect(tokenField().getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('.sc-fld__error')?.textContent).toBe(
      'A token has three parts joined by dots: header.payload.signature.',
    );
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    await paste(user, tokenField(), 'a.b.c.d.e');
    expect(document.querySelector('.sc-fld__error')?.textContent).toContain('encrypted token');
    await paste(user, tokenField(), 'a'.repeat(100_001));
    expect(document.querySelector('.sc-fld__error')?.textContent).toBe(
      'This token is too long (at most 100,000 characters).',
    );
  });

  it('copies the header and the payload', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await paste(user, tokenField(), hmacToken('HS256', secret, { sub: 'x' }));
    await user.click(screen.getByRole('button', { name: 'Copy payload' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('{\n  "sub": "x"\n}');
    });
    await user.click(screen.getByRole('button', { name: 'Copy header' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('{\n  "alg": "HS256",\n  "typ": "JWT"\n}');
    });
  });
});

describe('checking the signature', () => {
  let user: User;
  const secret = randomSecret();
  const claims = { sub: 'user-1' };

  beforeEach(async () => {
    user = userEvent.setup();
    await openTool(manifest);
  });

  async function verify(): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Verify signature' }));
  }

  it('says when the secret is right, and what that does and does not mean', async () => {
    await paste(user, tokenField(), hmacToken('HS256', secret, claims));
    await paste(user, keyField(), secret);
    await verify();
    await waitFor(() => {
      expect(statusText()).toBe('The signature is valid for this key.');
    });
    expect(screen.getByText(/does not check exp, nbf, iss or aud/)).toBeTruthy();
    expect(alertText()).toBe('');
  });

  it('says when the secret is wrong, in the alert region', async () => {
    await paste(user, tokenField(), hmacToken('HS256', secret, claims));
    await paste(user, keyField(), randomSecret());
    await verify();
    await waitFor(() => {
      expect(alertText()).toBe('The signature does NOT match this key.');
    });
    expect(statusText()).toBe('');
    expect(screen.queryByText(/does not check exp/)).toBeNull();
  });

  it('forgets the result when the token, the key or the option changes', async () => {
    await paste(user, tokenField(), hmacToken('HS256', secret, claims));
    await paste(user, keyField(), secret);
    await verify();
    await waitFor(() => {
      expect(statusText()).not.toBe('');
    });
    await user.type(keyField(), 'x');
    expect(statusText()).toBe('');
    await user.clear(keyField());
    await user.type(keyField(), secret);
    await verify();
    await waitFor(() => {
      expect(statusText()).not.toBe('');
    });
    await user.click(
      screen.getByRole('checkbox', { name: 'The secret is Base64 or Base64url encoded' }),
    );
    expect(statusText()).toBe('');
    await paste(user, tokenField(), tamperSignature(hmacToken('HS256', secret, claims)));
    expect(alertText()).toBe('');
  });

  it('reads a Base64 secret when the option is on', async () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 3) % 256);
    await paste(user, tokenField(), hmacToken('HS256', bytes, claims));
    await paste(user, keyField(), Buffer.from(bytes).toString('base64'));
    await user.click(
      screen.getByRole('checkbox', { name: 'The secret is Base64 or Base64url encoded' }),
    );
    await verify();
    await waitFor(() => {
      expect(statusText()).toBe('The signature is valid for this key.');
    });
  });

  it('checks an ES256 token against its public key, and offers the checkbox only for HS tokens', async () => {
    const pair = ecKeys('P-256');
    await paste(user, tokenField(), ecToken('ES256', pair, claims));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/The public key as PEM/)).toBeTruthy();
    await paste(user, keyField(), pair.publicPem);
    await verify();
    await waitFor(() => {
      expect(statusText()).toBe('The signature is valid for this key.');
    });
    await paste(user, keyField(), ecKeys('P-384').publicPem);
    await verify();
    await waitFor(() => {
      expect(alertText()).toContain('cannot be used for ES256');
    });
  });

  it('refuses a public key as an HMAC secret and a private key anywhere', async () => {
    const pair = ecKeys('P-256');
    await paste(user, tokenField(), hmacToken('HS256', pair.publicPem, claims));
    await paste(user, keyField(), pair.publicPem);
    await verify();
    await waitFor(() => {
      expect(alertText()).toContain('wrong kind for HS256');
    });
    await paste(user, tokenField(), ecToken('ES256', pair, claims));
    await paste(user, keyField(), pair.privatePem);
    await verify();
    await waitFor(() => {
      expect(alertText()).toContain('This is a private key');
    });
  });

  it('explains why an unsecured token or a missing key cannot be checked', async () => {
    await paste(user, tokenField(), `${signingInput({ alg: 'none' }, claims)}.`);
    await verify();
    await waitFor(() => {
      expect(alertText()).toBe('The algorithm is "none": there is no signature to check.');
    });
    await paste(user, tokenField(), hmacToken('HS256', secret, claims));
    await verify();
    await waitFor(() => {
      expect(alertText()).toBe('Paste a key first.');
    });
    await paste(user, tokenField(), `${signingInput({ alg: 'EdDSA' }, claims)}.abcd`);
    await paste(user, keyField(), 'k');
    await verify();
    await waitFor(() => {
      expect(alertText()).toBe('The algorithm EdDSA is not supported here.');
    });
  });

  it('refuses a key that is too long, in the field, and disables the button', async () => {
    await paste(user, tokenField(), hmacToken('HS256', secret, claims));
    await user.click(keyField());
    await user.paste('k'.repeat(20_001));
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Verify signature' }).disabled,
    ).toBe(true);
    expect(document.querySelector('.sc-fld__error')?.textContent).toBe(
      'This key is too long (at most 20,000 characters).',
    );
  });

  it('never writes a token or a key to the console', async () => {
    await paste(user, tokenField(), hmacToken('HS256', secret, claims));
    await paste(user, keyField(), secret);
    await verify();
    await waitFor(() => {
      expect(statusText()).not.toBe('');
    });
    expect(consoleSpies).toHaveLength(logs.length);
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('shows German texts', async () => {
    await paste(user, tokenField(), hmacToken('HS256', secret, { exp: SECONDS - 3600 }));
    i18n.setLocale('de');
    expect(await screen.findByRole('textbox', { name: 'Schlüssel' })).toBeTruthy();
    expect(timeRows('Die Zeit-Claims des Tokens')[0]?.[2]).toBe('Abgelaufen vor 1 Stunde');
    expect(screen.getByText(/Nur dekodiert, nicht geprüft\./)).toBeTruthy();
  });
});
