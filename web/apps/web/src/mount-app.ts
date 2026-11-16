import { mount, unmount } from 'svelte';
import App from './App.svelte';

export interface MountedApp {
  /** Removes the app from the DOM and runs its teardown. */
  readonly destroy: () => void;
}

/** Mounts the app into the element with `id`; throws when the element is missing. */
export function mountApp(id: string, doc: Document = document): MountedApp {
  const target = doc.getElementById(id);
  if (target === null) {
    throw new Error(`mount target #${id} not found`);
  }
  const instance = mount(App, { target });
  return {
    destroy: (): void => {
      void unmount(instance);
    },
  };
}
