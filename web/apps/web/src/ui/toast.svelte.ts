export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
}

export interface ToastOptions {
  readonly kind?: ToastKind;
  /** Milliseconds until it dismisses itself; `null` keeps it until the visitor closes it. */
  readonly durationMs?: number | null;
}

/** Errors stay (WCAG 2.2.1: no time limit on what the visitor has to read and act on). */
export const DEFAULT_DURATION_MS: Readonly<Record<ToastKind, number | null>> = {
  info: 6000,
  success: 6000,
  warn: 10_000,
  error: null,
};

/** Oldest toasts go first when more than this many are open. */
export const MAX_TOASTS = 5;

interface Timer {
  handle: ReturnType<typeof setTimeout> | undefined;
  remainingMs: number;
  startedAt: number;
}

/** Toast queue: auto-dismiss timers that pause while a toast is hovered or focused. */
export class Toaster {
  items = $state<Toast[]>([]);
  #nextId = 1;
  readonly #timers = new Map<number, Timer>();

  /** Shows a message and returns its id. */
  push(message: string, options: ToastOptions = {}): number {
    const kind = options.kind ?? 'info';
    const durationMs =
      options.durationMs === undefined ? DEFAULT_DURATION_MS[kind] : options.durationMs;
    const id = this.#nextId;
    this.#nextId += 1;
    this.items = [...this.items, { id, kind, message }];
    if (durationMs !== null) {
      this.#timers.set(id, { handle: undefined, remainingMs: durationMs, startedAt: 0 });
      this.resume(id);
    }
    for (const oldest of this.items.slice(0, Math.max(0, this.items.length - MAX_TOASTS))) {
      this.dismiss(oldest.id);
    }
    return id;
  }

  dismiss(id: number): void {
    this.#clearTimer(id);
    this.#timers.delete(id);
    this.items = this.items.filter((toast) => toast.id !== id);
  }

  clear(): void {
    for (const id of [...this.#timers.keys()]) {
      this.#clearTimer(id);
    }
    this.#timers.clear();
    this.items = [];
  }

  /** Stops the countdown (hover, focus); no effect on toasts without a timer. */
  pause(id: number): void {
    const timer = this.#timers.get(id);
    if (timer?.handle === undefined) {
      return;
    }
    clearTimeout(timer.handle);
    timer.handle = undefined;
    timer.remainingMs = Math.max(0, timer.remainingMs - (Date.now() - timer.startedAt));
  }

  /** Continues the countdown with the time that was left. */
  resume(id: number): void {
    const timer = this.#timers.get(id);
    if (timer === undefined || timer.handle !== undefined) {
      return;
    }
    timer.startedAt = Date.now();
    timer.handle = setTimeout(() => {
      this.dismiss(id);
    }, timer.remainingMs);
  }

  #clearTimer(id: number): void {
    const handle = this.#timers.get(id)?.handle;
    if (handle !== undefined) {
      clearTimeout(handle);
    }
  }
}

/** The app-wide queue; `<ToastRegion />` renders it. */
export const toaster = new Toaster();
