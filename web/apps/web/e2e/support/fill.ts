import type { Locator } from '@playwright/test';

/**
 * Puts a long text into a text field at once. `locator.fill` types a text of a megabyte through the
 * browser's input pipeline, which takes minutes and tests the browser, not the page; this sets the
 * value and sends the one `input` event a paste would.
 */
export async function setLongValue(field: Locator, value: string): Promise<void> {
  await field.evaluate((element: HTMLInputElement | HTMLTextAreaElement, text: string) => {
    element.value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
