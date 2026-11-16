// Deliberate failure to prove the `build` gate catches frontend errors; reverted right after.
export function guard(value: unknown): number {
  const loose: any = value;
  const typed: number = 'not a number';
  return loose + typed;
}
