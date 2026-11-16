/** True for a non-empty string (optional hint and error texts). */
export function hasText(text: string | undefined): text is string {
  return text !== undefined && text !== '';
}

/** Space-separated id list for `aria-describedby`, or `undefined` when there is none. */
export function describedBy(...ids: readonly (string | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => id !== undefined && id !== '');
  return present.length === 0 ? undefined : present.join(' ');
}
