/**
 * Made-up vendor lists in the layout of the IEEE CSV files. No real registry data is in the
 * repository: the names are invented and the assignments are not the ones IEEE lists.
 */

export const HEADER = 'Registry,Assignment,Organization Name,Organization Address';

/** One CSV row per `[registry, assignment, name]`, quoted where needed. */
export function csv(rows: readonly (readonly string[])[]): string {
  const quote = (cell: string): string =>
    /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
  return `${[HEADER, ...rows.map((row) => row.map(quote).join(','))].join('\r\n')}\r\n`;
}

/** A list of three MA-L entries; one name has quotes and a comma, one address has a line break. */
export const SAMPLE_MA_L = [
  HEADER,
  'MA-L,00A0B0,Example Networks Ltd,"1 Example Street\nSampletown"',
  'MA-L,04D5E6,"Sample ""Quoted"" Devices, Inc.",Somewhere',
  'MA-L,08F1A2,Test Systems GmbH,',
  '',
].join('\r\n');

/** MA-M and MA-S entries, as the files `mam.csv` and `oui36.csv` list them. */
export const SAMPLE_MA_M = csv([['MA-M', '1C2D3E4', 'Medium Block Co', 'Example Road']]);
export const SAMPLE_MA_S = csv([['MA-S', '8C1F64ABC', 'Small Block Co', 'Example Lane']]);

/** A `File` as the browser makes it from the file chooser. */
export function csvFile(name: string, text: string): File {
  return new File([text], name, { type: 'text/csv' });
}
