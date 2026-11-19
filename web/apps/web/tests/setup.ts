import { configure } from '@testing-library/dom';

/**
 * jsdom lacks the modal behaviour of `<dialog>`. This is a faithful stand-in for the two
 * methods the components use: `showModal()` opens it, `close()` closes it and fires `close`
 * (only when it was open, like the platform).
 */
function installDialogMethods(): void {
  const proto = HTMLDialogElement.prototype;
  Object.defineProperty(proto, 'showModal', {
    configurable: true,
    writable: true,
    value(this: HTMLDialogElement): void {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(proto, 'close', {
    configurable: true,
    writable: true,
    value(this: HTMLDialogElement): void {
      if (!this.hasAttribute('open')) {
        return;
      }
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    },
  });
}

installDialogMethods();

/** jsdom does not implement scrolling (it only logs "not implemented"); the router scrolls to the top. */
Object.defineProperty(window, 'scrollTo', {
  configurable: true,
  writable: true,
  value: (): void => undefined,
});

/** Routes load through dynamic imports, which are slow the first time on a busy machine. */
configure({ asyncUtilTimeout: 5000 });
