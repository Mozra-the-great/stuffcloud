import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ToastRegion from '../src/ui/ToastRegion.svelte';
import {
  DEFAULT_DURATION_MS,
  MAX_TOASTS,
  Toaster,
  toaster as sharedToaster,
} from '../src/ui/toast.svelte.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  sharedToaster.clear();
});

function messages(toaster: Toaster): string[] {
  return toaster.items.map((toast) => toast.message);
}

describe('Toaster', () => {
  it('has the documented default durations: errors stay until dismissed', () => {
    expect(DEFAULT_DURATION_MS).toEqual({ info: 6000, success: 6000, warn: 10_000, error: null });
  });

  it('pushes a toast with an increasing id and the info kind by default', () => {
    const toaster = new Toaster();
    const first = toaster.push('one');
    const second = toaster.push('two');
    expect(second).toBe(first + 1);
    expect(toaster.items).toEqual([
      { id: first, kind: 'info', message: 'one' },
      { id: second, kind: 'info', message: 'two' },
    ]);
  });

  it.each([
    ['info', 6000],
    ['success', 6000],
    ['warn', 10_000],
  ] as const)('dismisses a %s toast after its default time, not before', (kind, duration) => {
    const toaster = new Toaster();
    toaster.push('m', { kind });
    vi.advanceTimersByTime(duration - 1);
    expect(toaster.items).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toaster.items).toHaveLength(0);
  });

  it('keeps an error until it is dismissed', () => {
    const toaster = new Toaster();
    const id = toaster.push('bad', { kind: 'error' });
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(toaster.items).toHaveLength(1);
    toaster.dismiss(id);
    expect(toaster.items).toHaveLength(0);
  });

  it('honours an explicit duration, including null for sticky', () => {
    const toaster = new Toaster();
    toaster.push('short', { durationMs: 100 });
    toaster.push('sticky', { durationMs: null });
    toaster.push('error with timer', { kind: 'error', durationMs: 200 });
    vi.advanceTimersByTime(100);
    expect(messages(toaster)).toEqual(['sticky', 'error with timer']);
    vi.advanceTimersByTime(100);
    expect(messages(toaster)).toEqual(['sticky']);
  });

  it('dismiss removes one toast, cancels its timer and ignores unknown ids', () => {
    const toaster = new Toaster();
    const keep = toaster.push('keep');
    const drop = toaster.push('drop');
    toaster.dismiss(drop);
    toaster.dismiss(999);
    expect(messages(toaster)).toEqual(['keep']);
    expect(vi.getTimerCount()).toBe(1);
    toaster.dismiss(keep);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clear removes everything and every timer', () => {
    const toaster = new Toaster();
    toaster.push('a');
    toaster.push('b', { kind: 'error' });
    toaster.push('c', { kind: 'warn' });
    toaster.clear();
    expect(toaster.items).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pause stops the countdown and resume continues with the time that was left', () => {
    const toaster = new Toaster();
    const id = toaster.push('m', { durationMs: 1000 });
    vi.advanceTimersByTime(400);
    toaster.pause(id);
    vi.advanceTimersByTime(60_000);
    expect(toaster.items).toHaveLength(1);
    toaster.resume(id);
    vi.advanceTimersByTime(599);
    expect(toaster.items).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toaster.items).toHaveLength(0);
  });

  it('pause twice and resume twice change nothing; unknown ids and sticky toasts are ignored', () => {
    const toaster = new Toaster();
    const id = toaster.push('m', { durationMs: 1000 });
    const sticky = toaster.push('s', { kind: 'error' });
    vi.advanceTimersByTime(300);
    toaster.pause(id);
    toaster.pause(id);
    toaster.pause(999);
    toaster.pause(sticky);
    toaster.resume(id);
    toaster.resume(id);
    toaster.resume(999);
    toaster.resume(sticky);
    vi.advanceTimersByTime(699);
    expect(messages(toaster)).toEqual(['m', 's']);
    vi.advanceTimersByTime(1);
    expect(messages(toaster)).toEqual(['s']);
  });

  it('never lets the time left go below zero', () => {
    const toaster = new Toaster();
    const id = toaster.push('m', { durationMs: 100 });
    vi.setSystemTime(Date.now() + 10_000);
    toaster.pause(id);
    toaster.resume(id);
    vi.advanceTimersByTime(0);
    expect(toaster.items).toHaveLength(0);
  });

  it(`drops the oldest toast beyond ${String(MAX_TOASTS)}`, () => {
    const toaster = new Toaster();
    for (let index = 1; index <= MAX_TOASTS + 2; index += 1) {
      toaster.push(`m${String(index)}`, { durationMs: null });
    }
    expect(toaster.items).toHaveLength(MAX_TOASTS);
    expect(messages(toaster)[0]).toBe('m3');
    expect(messages(toaster).at(-1)).toBe(`m${String(MAX_TOASTS + 2)}`);
  });

  it('the shared instance is a Toaster', () => {
    expect(sharedToaster).toBeInstanceOf(Toaster);
  });
});

describe('ToastRegion', () => {
  function renderRegion(toaster: Toaster): void {
    render(ToastRegion, { label: 'Notifications', dismissLabel: 'Dismiss', toaster });
  }

  it('renders an empty named region with both live regions present from the start', () => {
    renderRegion(new Toaster());
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryAllByRole('group')).toHaveLength(0);
  });

  it('puts errors in the alert region and everything else in the status region', async () => {
    const toaster = new Toaster();
    renderRegion(toaster);
    toaster.push('saved', { kind: 'success' });
    toaster.push('heads up', { kind: 'warn' });
    toaster.push('note');
    toaster.push('broken', { kind: 'error' });
    await vi.waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('broken');
    });
    const status = screen.getByRole('status').textContent;
    expect(status).toContain('saved');
    expect(status).toContain('heads up');
    expect(status).toContain('note');
    expect(status).not.toContain('broken');
    expect(screen.getByRole('alert').textContent).not.toContain('saved');
  });

  it('colours by kind through the class', async () => {
    const toaster = new Toaster();
    renderRegion(toaster);
    toaster.push('x', { kind: 'warn' });
    await vi.waitFor(() => {
      expect(document.querySelector('.toast.warn')).not.toBeNull();
    });
  });

  it('dismisses with the button, which has an accessible name', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const toaster = new Toaster();
    renderRegion(toaster);
    toaster.push('bye');
    const button = await screen.findByRole('button', { name: 'Dismiss' });
    await user.click(button);
    expect(toaster.items).toHaveLength(0);
    await vi.waitFor(() => {
      expect(screen.queryByText('bye')).toBeNull();
    });
  });

  it('pauses on hover and resumes when the pointer leaves', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const toaster = new Toaster();
    renderRegion(toaster);
    toaster.push('hold', { durationMs: 1000 });
    const message = await screen.findByText('hold');
    await user.hover(message);
    vi.advanceTimersByTime(5000);
    expect(toaster.items).toHaveLength(1);
    await user.unhover(message);
    vi.advanceTimersByTime(1000);
    expect(toaster.items).toHaveLength(0);
  });

  it('pauses while a button inside has keyboard focus and resumes on blur', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const toaster = new Toaster();
    renderRegion(toaster);
    toaster.push('focus me', { durationMs: 1000 });
    await screen.findByText('focus me');
    await user.tab();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss');
    vi.advanceTimersByTime(5000);
    expect(toaster.items).toHaveLength(1);
    await user.tab();
    vi.advanceTimersByTime(1000);
    expect(toaster.items).toHaveLength(0);
  });

  it('uses the shared toaster by default', async () => {
    render(ToastRegion, { label: 'Notifications', dismissLabel: 'Dismiss' });
    sharedToaster.push('shared');
    expect(await screen.findByText('shared')).toBeTruthy();
  });
});
