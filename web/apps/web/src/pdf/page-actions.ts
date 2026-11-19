import { t, type MessageKey } from '../i18n/index.ts';
import type { Pages } from './page-edit.ts';

/** What a step of the page editor did; the sentence is made when it is announced, in the current language. */
export interface ActionLabel {
  readonly key: MessageKey;
  readonly count: number;
  readonly position?: number;
}

export function describeAction(label: ActionLabel): string {
  return t(label.key, { count: label.count, position: label.position ?? 0 });
}

/** The name of one page in the grid: its place now and the page it was in the file, and a turn. */
export function pageName(page: Pages[number], position: number): string {
  return page.turn === 0
    ? t('pdf.pages.pageLabel', { position, page: page.id + 1 })
    : t('pdf.pages.pageLabelTurned', { position, page: page.id + 1, degrees: page.turn });
}

/** A whole number from `1` to `max` typed by the visitor, or `undefined`. */
export function parsePosition(text: string, max: number): number | undefined {
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) {
    return undefined;
  }
  const value = Number(trimmed);
  return value >= 1 && value <= max ? value : undefined;
}
