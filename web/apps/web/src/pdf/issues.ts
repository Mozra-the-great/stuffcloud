import { i18n, t, type MessageKey } from '../i18n/index.ts';
import { formatBytes } from './format.ts';
import { MAX_TOTAL_INPUT_BYTES, MAX_TOTAL_PAGES } from './limits.ts';
import type { PdfIssue } from './types.ts';

const KEYS: Readonly<Record<PdfIssue, MessageKey>> = {
  encrypted: 'pdf.issue.encrypted',
  broken: 'pdf.issue.broken',
  empty: 'pdf.issue.empty',
  'too-large': 'pdf.issue.tooLarge',
  'out-of-memory': 'pdf.issue.memory',
};

/** The sentence that tells the visitor why `name` cannot be used. */
export function issueText(issue: PdfIssue, name: string): string {
  return t(KEYS[issue], {
    name,
    size: formatBytes(MAX_TOTAL_INPUT_BYTES, i18n.locale),
    pages: MAX_TOTAL_PAGES,
  });
}

/** What a failure of the worker itself (a crash, a message that broke the protocol) is called. */
export function failureText(): string {
  return t('pdf.issue.failed');
}

/** Whether an error is the abort of a job (the visitor pressed Cancel). */
export function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}
