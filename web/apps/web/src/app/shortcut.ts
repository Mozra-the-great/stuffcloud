/** Whether the key event is the search shortcut: Ctrl+K, or Cmd+K on Apple systems. */
export function isSearchShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'k'
  );
}

/** What the search button shows next to its name (`Ctrl K`, or the Command symbol on Apple systems). */
export function searchShortcutLabel(userAgent: string): string {
  return /Mac|iPhone|iPad/.test(userAgent) ? '⌘K' : 'Ctrl K';
}
