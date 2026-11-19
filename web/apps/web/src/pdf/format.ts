const UNITS: readonly (readonly [limit: number, unit: string])[] = [
  [1024 ** 3, 'gigabyte'],
  [1024 ** 2, 'megabyte'],
  [1024, 'kilobyte'],
];

/** A file size for people ("1.4 MB"), with 1024 as the step, in the number format of `locale`. */
export function formatBytes(bytes: number, locale: string): string {
  const [limit, unit] = UNITS.find(([threshold]) => bytes >= threshold) ?? [1, 'byte'];
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'narrow',
    maximumFractionDigits: unit === 'byte' ? 0 : 1,
  }).format(bytes / limit);
}
