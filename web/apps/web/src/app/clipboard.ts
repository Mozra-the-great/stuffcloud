/**
 * Puts text on the clipboard. Resolves to whether it worked: there is no clipboard outside a
 * secure context, and the browser may refuse (permission, no user gesture).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
