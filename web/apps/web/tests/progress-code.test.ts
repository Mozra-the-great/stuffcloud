import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CodeBlock from '../src/ui/CodeBlock.svelte';
import Progress from '../src/ui/Progress.svelte';
import { normaliseMax, progressPercent } from '../src/ui/progress.ts';

describe('normaliseMax', () => {
  it('keeps a positive finite maximum', () => {
    expect(normaliseMax(1)).toBe(1);
    expect(normaliseMax(0.5)).toBe(0.5);
    expect(normaliseMax(500)).toBe(500);
  });

  it('falls back to 100 for zero, negative and non-finite values', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(normaliseMax(bad)).toBe(100);
    }
  });
});

describe('progressPercent', () => {
  it.each([
    [0, 100, 0],
    [40, 100, 40],
    [100, 100, 100],
    [5, 10, 50],
    [1, 4, 25],
    [3, 12, 25],
  ])('%s of %s is %s percent', (value, max, expected) => {
    expect(progressPercent(value, max)).toBeCloseTo(expected, 10);
  });

  it('clamps to the range on both sides', () => {
    expect(progressPercent(-5, 100)).toBe(0);
    expect(progressPercent(150, 100)).toBe(100);
    expect(progressPercent(11, 10)).toBe(100);
  });

  it('defaults the maximum to 100', () => {
    expect(progressPercent(30)).toBe(30);
  });

  it('never draws a broken bar for bad input', () => {
    expect(progressPercent(Number.NaN, 100)).toBe(0);
    expect(progressPercent(Number.POSITIVE_INFINITY, 100)).toBe(0);
    expect(progressPercent(50, 0)).toBe(50);
    expect(progressPercent(50, -3)).toBe(50);
    expect(progressPercent(50, Number.NaN)).toBe(50);
  });
});

describe('Progress', () => {
  it('is a named progressbar with the ARIA value attributes', () => {
    render(Progress, { label: 'Upload', value: 40 });
    const bar = screen.getByRole('progressbar', { name: 'Upload' });
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(bar.getAttribute('aria-valuetext')).toBeNull();
    expect(bar.querySelector('i')?.style.width).toBe('40%');
  });

  it('scales to a custom maximum', () => {
    render(Progress, { label: 'Files', value: 3, max: 12, valueText: '3 of 12 files' });
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemax')).toBe('12');
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    expect(bar.getAttribute('aria-valuetext')).toBe('3 of 12 files');
    expect(bar.querySelector('i')?.style.width).toBe('25%');
  });

  it('clamps value to the range and survives a bad maximum', () => {
    const { unmount } = render(Progress, { label: 'A', value: 250 });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    unmount();
    render(Progress, { label: 'B', value: 50, max: 0 });
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
  });

  it('is indeterminate without a value: no aria-valuenow, no width, animated class', () => {
    render(Progress, { label: 'Working' });
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(bar.classList.contains('indeterminate')).toBe(true);
    expect(bar.querySelector('i')?.style.width).toBe('');
  });

  it('determinate bars are not marked indeterminate', () => {
    render(Progress, { label: 'Upload', value: 0 });
    const bar = screen.getByRole('progressbar');
    expect(bar.classList.contains('indeterminate')).toBe(false);
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
  });

  it('draws the warning tone', () => {
    const { unmount } = render(Progress, { label: 'Storage', value: 100, tone: 'warn' });
    expect(screen.getByRole('progressbar').classList.contains('warn')).toBe(true);
    unmount();
    render(Progress, { label: 'Storage', value: 100 });
    expect(screen.getByRole('progressbar').classList.contains('warn')).toBe(false);
  });
});

describe('CodeBlock', () => {
  const code = 'stuffcloud deploy ./dist --expires 7d';

  /** user-event installs its own clipboard stub in setup(), so replace it afterwards. */
  function setupUser(
    writeText?: (text: string) => Promise<void>,
  ): ReturnType<typeof userEvent.setup> {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: writeText === undefined ? undefined : { writeText },
    });
    return user;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('shows the code in a named, focusable, scrollable region', () => {
    render(CodeBlock, { code, label: 'Deploy command' });
    const region = screen.getByRole('region', { name: 'Deploy command' });
    expect(region.tagName).toBe('PRE');
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.textContent).toBe(code);
  });

  it('keeps whitespace and shows markup as text', () => {
    const tricky = '<b>x</b>\n  indented & more';
    render(CodeBlock, { code: tricky, label: 'Code' });
    expect(screen.getByRole('region').textContent).toBe(tricky);
    expect(document.querySelector('b')).toBeNull();
  });

  it('has no copy button unless asked for one', () => {
    render(CodeBlock, { code, label: 'Deploy command' });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('copies the code, announces it, and forgets after two seconds', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const oncopy = vi.fn();
    const user = setupUser(writeText);
    render(CodeBlock, {
      code,
      label: 'Deploy command',
      copyLabel: 'Copy',
      copiedLabel: 'Copied',
      oncopy,
    });

    expect(screen.getByRole('status').textContent).toBe('');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(code);
    expect(oncopy).toHaveBeenCalledWith(true);
    expect(screen.getByRole('status').textContent).toBe('Copied');

    await vi.advanceTimersByTimeAsync(1999);
    expect(screen.getByRole('status').textContent).toBe('Copied');
    await vi.advanceTimersByTimeAsync(1);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('a second copy restarts the two seconds', async () => {
    const user = setupUser(vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined));
    render(CodeBlock, { code, label: 'c', copyLabel: 'Copy', copiedLabel: 'Copied' });
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await vi.advanceTimersByTimeAsync(1500);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(screen.getByRole('status').textContent).toBe('Copied');
    await vi.advanceTimersByTimeAsync(500);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('reports a rejected copy and shows no success message', async () => {
    const oncopy = vi.fn();
    const user = setupUser(
      vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('denied')),
    );
    render(CodeBlock, { code, label: 'c', copyLabel: 'Copy', copiedLabel: 'Copied', oncopy });
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(oncopy).toHaveBeenCalledWith(false);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('reports a missing clipboard (insecure context) as a failed copy, without a callback too', async () => {
    const oncopy = vi.fn();
    const user = setupUser();
    render(CodeBlock, { code, label: 'c', copyLabel: 'Copy', oncopy });
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(oncopy).toHaveBeenCalledWith(false);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('shows nothing after a successful copy when no copied label is given', async () => {
    const user = setupUser(vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined));
    render(CodeBlock, { code, label: 'c', copyLabel: 'Copy' });
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.getByRole('status').textContent).toBe('');
  });
});
