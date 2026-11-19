/**
 * Reactive `navigator.onLine`: what the browser knows, which is a hint and not a guarantee.
 * Candidate for kern (#121).
 */
export class OnlineStatus {
  readonly #window: Window;
  #online = $state(true);

  constructor(win: Window = window) {
    this.#window = win;
    this.#online = win.navigator.onLine;
  }

  get online(): boolean {
    return this.#online;
  }

  /** Follows the browser's `online`/`offline` events; returns the function that stops it. */
  start(): () => void {
    const update = (): void => {
      this.#online = this.#window.navigator.onLine;
    };
    update();
    this.#window.addEventListener('online', update);
    this.#window.addEventListener('offline', update);
    return (): void => {
      this.#window.removeEventListener('online', update);
      this.#window.removeEventListener('offline', update);
    };
  }
}
