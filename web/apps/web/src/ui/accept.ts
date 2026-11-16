/**
 * Whether `file` satisfies an `accept` attribute value (the same grammar as
 * `<input type="file" accept>`: comma-separated `.ext`, `type/*` and `type/subtype`).
 * An empty or missing list accepts everything. Looks at name and MIME type only, never at
 * the content (files stay on the device).
 */
export function matchesAccept(
  file: Pick<File, 'name' | 'type'>,
  accept: string | undefined,
): boolean {
  const patterns = (accept ?? '')
    .split(',')
    .map((pattern) => pattern.trim().toLowerCase())
    .filter((pattern) => pattern !== '');
  if (patterns.length === 0) {
    return true;
  }
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return patterns.some((pattern) => {
    if (pattern.startsWith('.')) {
      return name.endsWith(pattern);
    }
    if (pattern.endsWith('/*')) {
      return type.startsWith(pattern.slice(0, -1));
    }
    return type === pattern;
  });
}

export interface SplitFiles {
  readonly accepted: File[];
  readonly rejected: File[];
}

/** Splits a drop into accepted and rejected files; without `multiple` only the first accepted one stays. */
export function splitFiles(
  files: readonly File[],
  accept: string | undefined,
  multiple: boolean,
): SplitFiles {
  const accepted: File[] = [];
  const rejected: File[] = [];
  for (const file of files) {
    if (matchesAccept(file, accept)) {
      accepted.push(file);
    } else {
      rejected.push(file);
    }
  }
  if (!multiple && accepted.length > 1) {
    return { accepted: accepted.slice(0, 1), rejected: [...rejected, ...accepted.slice(1)] };
  }
  return { accepted, rejected };
}
