import { expect, test } from '../support/fixtures.ts';
import { expectKeyboardOnly } from '../support/keyboard.ts';

// JWT decoder in the built app, in Chromium and Firefox (T-05, #13: the accessibility gate applies to
// every tool). Add a test per state of the tool; call `a11y.check(page, '<state>')` after each
// one, and `net.watch(file)` for each file the test uploads.
test.describe('jwt', () => {
  test('opens with one heading and passes the accessibility gate', async ({ page, a11y }) => {
    await page.goto('/tools/jwt');
    await expect(
      page.getByRole('heading', { level: 1, name: 'JWT decoder', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await a11y.check(page, 'jwt');
  });

  test('can be used with the keyboard alone', async ({ page }) => {
    await page.goto('/tools/jwt');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectKeyboardOnly(page, 'jwt');
  });
});
