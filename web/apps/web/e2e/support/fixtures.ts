import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { createA11yGate, type A11yGate } from './a11y.ts';
import { NetworkRecorder } from './network.ts';

interface Options {
  /**
   * The privacy rules (own origin only, `GET` of own assets only, no file content) apply to every
   * test and fail it at the end. Only the tests that leak on purpose switch this off.
   */
  enforcePrivacy: boolean;
}

interface Fixtures {
  /** Every request of the test, with the privacy rules. */
  net: NetworkRecorder;
  /** Uncaught errors of the page; a test fails when there are any. */
  pageErrors: string[];
  a11y: A11yGate;
}

/** The app origin, as in `baseURL` of the config. */
function originOf(baseURL: string | undefined): string {
  if (baseURL === undefined) {
    throw new Error('the Playwright config must set `use.baseURL`');
  }
  return new URL(baseURL).origin;
}

export const test = base.extend<Fixtures & Options>({
  enforcePrivacy: [true, { option: true }],

  net: [
    async ({ context, baseURL, enforcePrivacy }, use) => {
      const recorder = new NetworkRecorder(context, originOf(baseURL));
      await use(recorder);
      recorder.dispose();
      if (enforcePrivacy) {
        recorder.assertClean();
      }
    },
    { auto: true },
  ],

  pageErrors: [
    async ({ context }, use) => {
      const errors: string[] = [];
      const listen = (page: Page): void => {
        page.on('pageerror', (error) => {
          errors.push(error.message);
        });
      };
      context.on('page', listen);
      await use(errors);
      context.off('page', listen);
      expect(errors, 'uncaught errors in the page').toEqual([]);
    },
    { auto: true },
  ],

  // The accessibility gate is off until T-05 (#13) passes an axe runner here.
  // eslint-disable-next-line no-empty-pattern
  a11y: async ({}, use) => {
    await use(createA11yGate());
  },
});

export { expect };

/** Attaches a screenshot of the page to the test report (a smoke artifact, never compared). */
export async function attachScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ animations: 'disabled', fullPage: true }),
    contentType: 'image/png',
  });
}
