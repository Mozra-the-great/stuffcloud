import { screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { mountApp, type MountedApp } from '../src/mount-app.ts';

let mounted: MountedApp | undefined;

afterEach(() => {
  mounted?.destroy();
  mounted = undefined;
  document.body.replaceChildren();
});

function addTarget(id: string): HTMLElement {
  const element = document.createElement('div');
  element.id = id;
  document.body.append(element);
  return element;
}

describe('mountApp', () => {
  it('renders the app shell with the home page inside a main landmark', async () => {
    const target = addTarget('app');
    mounted = mountApp('app');

    expect(target.querySelector('header')).not.toBeNull();
    expect(target.querySelector('footer')).not.toBeNull();
    const main = target.querySelector('main');
    expect(main).not.toBeNull();
    await screen.findByRole('heading', { level: 1 });
    expect(main?.querySelector('h1')?.textContent).toBe('Your stuff, in your cloud.');
  });

  it('mounts into the requested element only', () => {
    const other = addTarget('other');
    const target = addTarget('app');
    mounted = mountApp('app');

    expect(target.querySelector('main')).not.toBeNull();
    expect(other.querySelector('main')).toBeNull();
  });

  it('throws naming the missing element', () => {
    expect(() => mountApp('app')).toThrow('mount target #app not found');
  });

  it('removes the app again on destroy', () => {
    const target = addTarget('app');
    const app = mountApp('app');
    expect(target.querySelector('main')).not.toBeNull();

    app.destroy();

    expect(target.querySelector('main')).toBeNull();
  });
});

describe('main entry', () => {
  it('mounts the app into #app on import', async () => {
    addTarget('app');

    await import('../src/main.ts');

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Your stuff, in your cloud.',
    );
  });
});
