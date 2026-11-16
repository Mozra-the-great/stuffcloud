/**
 * Index of the tab a key moves to (WAI-ARIA tabs pattern: arrows wrap around, Home and End
 * jump to the ends), or `undefined` for every other key.
 */
export function nextTabIndex(key: string, index: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}
