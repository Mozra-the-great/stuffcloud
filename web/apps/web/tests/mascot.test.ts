import { render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Mascot from '../src/ui/Mascot.svelte';
import { MASCOT_NAMES, MASCOTS } from '../src/ui/mascots.ts';
import { readAppFile } from './helpers.ts';

type ObserverCallback = (entries: IntersectionObserverEntry[]) => void;

interface FakeObserver {
  readonly callback: ObserverCallback;
  readonly observed: Element[];
  disconnected: boolean;
}

const observers: FakeObserver[] = [];

function installObserver(): void {
  class Fake {
    private readonly state: FakeObserver;
    constructor(callback: ObserverCallback) {
      this.state = { callback, observed: [], disconnected: false };
      observers.push(this.state);
    }
    observe(element: Element): void {
      this.state.observed.push(element);
    }
    disconnect(): void {
      this.state.disconnected = true;
    }
  }
  vi.stubGlobal('IntersectionObserver', Fake);
}

function entry(isIntersecting: boolean): IntersectionObserverEntry {
  return { isIntersecting } as IntersectionObserverEntry;
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

function mascotOf(container: HTMLElement): HTMLElement {
  const host = container.querySelector<HTMLElement>('[data-mascot]');
  if (host === null) {
    throw new Error('no mascot rendered');
  }
  return host;
}

function imageOf(container: HTMLElement): HTMLImageElement {
  const image = container.querySelector('img');
  if (image === null) {
    throw new Error('no image rendered');
  }
  return image;
}

beforeEach(() => {
  observers.length = 0;
  setVisibility('visible');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Mascot markup', () => {
  it.each(MASCOT_NAMES)('%s draws its own svg, decoratively, without any text', (name) => {
    const { container } = render(Mascot, { name });
    const image = imageOf(container);
    expect(image.getAttribute('src')).toBe(MASCOTS[name].url);
    expect(image.getAttribute('alt')).toBe('');
    expect(image.getAttribute('aria-hidden')).toBe('true');
    expect(image.getAttribute('draggable')).toBe('false');
    expect(mascotOf(container).dataset['mascot']).toBe(name);
    // Mascots never speak and carry no filler text.
    expect(container.textContent.trim()).toBe('');
  });

  it('gives the image a text alternative (and exposes it) when a label is set', () => {
    const { container } = render(Mascot, { name: 'boo', label: 'Page expired' });
    const image = imageOf(container);
    expect(image.getAttribute('alt')).toBe('Page expired');
    expect(image.hasAttribute('aria-hidden')).toBe(false);
  });

  it('reserves its box with width and height attributes at an integer scale', () => {
    const { container } = render(Mascot, { name: 'stuffy', scale: 16 });
    const image = imageOf(container);
    expect(image.getAttribute('width')).toBe('256');
    expect(image.getAttribute('height')).toBe('176');
    expect(mascotOf(container).style.getPropertyValue('--scale')).toBe('16');
    expect(mascotOf(container).style.getPropertyValue('--cols')).toBe('16');
    expect(mascotOf(container).style.getPropertyValue('--rows')).toBe('11');
  });

  it('cuts fractional and invalid scales to whole pixels', () => {
    const fractional = render(Mascot, { name: 'cumulo', scale: 5.8 });
    expect(imageOf(fractional.container).getAttribute('width')).toBe('70');
    expect(mascotOf(fractional.container).style.getPropertyValue('--scale')).toBe('5');
    const invalid = render(Mascot, { name: 'cumulo', scale: Number.NaN });
    expect(imageOf(invalid.container).getAttribute('width')).toBe('14');
    expect(mascotOf(invalid.container).style.getPropertyValue('--scale')).toBe('1');
  });

  it('uses the same scale on phones unless a compact scale is given (also whole)', () => {
    const same = render(Mascot, { name: 'hop', scale: 6 });
    expect(mascotOf(same.container).style.getPropertyValue('--scale-compact')).toBe('6');
    const compact = render(Mascot, { name: 'hop', scale: 16, compactScale: 9.9 });
    expect(mascotOf(compact.container).style.getPropertyValue('--scale-compact')).toBe('9');
  });

  it('defaults to scale 8', () => {
    const { container } = render(Mascot, { name: 'bun' });
    expect(imageOf(container).getAttribute('width')).toBe('96');
  });

  it('uses only custom-property and attribute styling the CSP allows (no inline style attribute text)', () => {
    const { container } = render(Mascot, { name: 'stuffy' });
    // Svelte sets `style:` directives through the CSSOM; nothing but custom properties appears.
    const declared = mascotOf(container).style;
    for (let index = 0; index < declared.length; index += 1) {
      expect(declared.item(index)).toMatch(/^--/);
    }
  });
});

describe('Mascot motion state', () => {
  it('runs by default', () => {
    const { container } = render(Mascot, { name: 'stuffy' });
    expect(mascotOf(container).dataset['motion']).toBe('running');
  });

  it('is still when animated is false, and never observes or listens', () => {
    installObserver();
    const add = vi.spyOn(document, 'addEventListener');
    const { container } = render(Mascot, { name: 'stuffy', animated: false });
    expect(mascotOf(container).dataset['motion']).toBe('still');
    expect(observers).toHaveLength(0);
    expect(add).not.toHaveBeenCalledWith('visibilitychange', expect.anything());
    add.mockRestore();
  });

  it('pauses while the tab is hidden and resumes when it is shown again', async () => {
    const { container } = render(Mascot, { name: 'stuffy' });
    setVisibility('hidden');
    await vi.waitFor(() => {
      expect(mascotOf(container).dataset['motion']).toBe('paused');
    });
    setVisibility('visible');
    await vi.waitFor(() => {
      expect(mascotOf(container).dataset['motion']).toBe('running');
    });
  });

  it('starts paused when the tab is already hidden on mount', async () => {
    setVisibility('hidden');
    const { container } = render(Mascot, { name: 'stuffy' });
    await vi.waitFor(() => {
      expect(mascotOf(container).dataset['motion']).toBe('paused');
    });
  });

  it('observes the mascot and pauses while it is outside the viewport', async () => {
    installObserver();
    const { container } = render(Mascot, { name: 'stuffy' });
    expect(observers).toHaveLength(1);
    expect(observers[0]?.observed).toEqual([mascotOf(container)]);
    observers[0]?.callback([entry(false)]);
    await vi.waitFor(() => {
      expect(mascotOf(container).dataset['motion']).toBe('paused');
    });
    observers[0]?.callback([entry(true)]);
    await vi.waitFor(() => {
      expect(mascotOf(container).dataset['motion']).toBe('running');
    });
  });

  it('follows the latest entry when several arrive at once', async () => {
    installObserver();
    const { container } = render(Mascot, { name: 'stuffy' });
    observers[0]?.callback([entry(false), entry(true)]);
    await vi.waitFor(() => {
      expect(mascotOf(container).dataset['motion']).toBe('running');
    });
    observers[0]?.callback([entry(true), entry(false)]);
    await vi.waitFor(() => {
      expect(mascotOf(container).dataset['motion']).toBe('paused');
    });
  });

  it('ignores an observer call without entries', () => {
    installObserver();
    const { container } = render(Mascot, { name: 'stuffy' });
    observers[0]?.callback([]);
    expect(mascotOf(container).dataset['motion']).toBe('running');
  });

  it('stays hidden-paused even when it is in view, and in-view paused when the tab is visible', async () => {
    installObserver();
    const { container } = render(Mascot, { name: 'stuffy' });
    setVisibility('hidden');
    observers[0]?.callback([entry(true)]);
    await vi.waitFor(() => {
      expect(mascotOf(container).dataset['motion']).toBe('paused');
    });
    setVisibility('visible');
    observers[0]?.callback([entry(false)]);
    await vi.waitFor(() => {
      expect(mascotOf(container).dataset['motion']).toBe('paused');
    });
  });

  it('keeps running where IntersectionObserver does not exist', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { container } = render(Mascot, { name: 'stuffy' });
    expect(mascotOf(container).dataset['motion']).toBe('running');
  });

  it('disconnects the observer and removes the listener on unmount', () => {
    installObserver();
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(Mascot, { name: 'stuffy' });
    unmount();
    expect(observers[0]?.disconnected).toBe(true);
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    remove.mockRestore();
  });
});

describe('Mascot stylesheet', () => {
  const source = readAppFile('src/ui/Mascot.svelte');
  const style = source.slice(source.indexOf('<style>'));

  it('scales pixel art without smoothing', () => {
    expect(style).toMatch(/image-rendering:\s*pixelated;/);
  });

  it('animates only transform, in two steps, never layout or paint properties', () => {
    const animated = /@keyframes bob \{[\s\S]*?\n {2}\}/.exec(style)?.[0] ?? '';
    expect(animated).toContain('transform: translateY(0);');
    const properties = [...animated.matchAll(/^\s+([a-z-]+):/gm)].map((match) => match[1]);
    expect(new Set(properties)).toEqual(new Set(['transform']));
    expect(style).toContain('steps(1) infinite');
  });

  it('shows the still pose under prefers-reduced-motion, for every motion state', () => {
    const media =
      /@media \(prefers-reduced-motion: reduce\) \{\s*\[data-motion\] img \{\s*animation: none;\s*\}\s*\}/.exec(
        style,
      );
    expect(media).not.toBeNull();
  });

  it('pauses with animation-play-state and never lets the box move', () => {
    expect(style).toMatch(/\[data-motion='paused'\] img \{\s*animation-play-state: paused;/);
    expect(style).not.toMatch(/will-change|position:\s*(absolute|fixed)/);
  });

  it('does no layout reads in the script (nothing that forces layout)', () => {
    const script = source.slice(0, source.indexOf('</script>'));
    expect(script).not.toMatch(
      /getBoundingClientRect|offsetWidth|offsetHeight|clientWidth|clientHeight|getComputedStyle|requestAnimationFrame|setInterval|setTimeout/,
    );
  });
});
