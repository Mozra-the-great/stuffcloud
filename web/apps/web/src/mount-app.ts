import { mount, unmount, type Component } from 'svelte';
import App from './App.svelte';

export interface MountedApp {
  /** Removes the app from the DOM and runs its teardown. */
  readonly destroy: () => void;
}

/**
 * Mounts a root component (the app by default) into the element with `id`; throws when the
 * element is missing.
 */
export function mountApp(id: string, doc: Document = document, root: Component = App): MountedApp {
  const target = doc.getElementById(id);
  if (target === null) {
    throw new Error(`mount target #${id} not found`);
  }
  const instance = mount(root, { target });
  return {
    destroy: (): void => {
      void unmount(instance);
    },
  };
}
