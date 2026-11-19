/**
 * Undo and redo for immutable states. `label` describes the change that produced a state, so the
 * page can say what was undone or redone.
 */

export interface Entry<T, L> {
  readonly value: T;
  readonly label: L;
}

export interface History<T, L> {
  /** Older states, oldest first. */
  readonly past: readonly Entry<T, L>[];
  readonly present: Entry<T, L>;
  /** Undone states, the next redo first. */
  readonly future: readonly Entry<T, L>[];
}

/** Oldest states are forgotten beyond this many steps. */
export const MAX_HISTORY = 200;

export function startHistory<T, L>(value: T, label: L): History<T, L> {
  return { past: [], present: { value, label }, future: [] };
}

/** A new state; redo is gone, as in every editor. */
export function commit<T, L>(history: History<T, L>, value: T, label: L): History<T, L> {
  const past = [...history.past, history.present].slice(-MAX_HISTORY);
  return { past, present: { value, label }, future: [] };
}

export function canUndo<T, L>(history: History<T, L>): boolean {
  return history.past.length > 0;
}

export function canRedo<T, L>(history: History<T, L>): boolean {
  return history.future.length > 0;
}

/** One step back; the same history when there is nothing to undo. */
export function undo<T, L>(history: History<T, L>): History<T, L> {
  const previous = history.past.at(-1);
  if (previous === undefined) {
    return history;
  }
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

/** One step forward; the same history when there is nothing to redo. */
export function redo<T, L>(history: History<T, L>): History<T, L> {
  const [next, ...rest] = history.future;
  if (next === undefined) {
    return history;
  }
  return { past: [...history.past, history.present], present: next, future: rest };
}
