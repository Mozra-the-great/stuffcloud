/** The value, or a failed test: for what a test has just shown must be there. */
export function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('expected a value, got ' + String(value));
  }
  return value;
}
