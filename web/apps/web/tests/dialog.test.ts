import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import Host from './DialogHost.svelte';

function dialogElement(): HTMLDialogElement {
  const dialog = document.querySelector('dialog');
  if (dialog === null) {
    throw new Error('no dialog in the document');
  }
  return dialog;
}

describe('Dialog', () => {
  it('stays closed until open is true', () => {
    render(Host, { open: false });
    expect(dialogElement().hasAttribute('open')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('open').textContent).toBe('closed');
  });

  it('opens modally, named by its heading, with a close button and the actions row', () => {
    render(Host, { open: true });
    const dialog = screen.getByRole('dialog', { name: 'Delete site' });
    expect(dialog).toBe(dialogElement());
    expect(screen.getByRole('heading', { level: 2, name: 'Delete site' })).toBeTruthy();
    expect(screen.getByText('my-site.example')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
  });

  it('has no actions row without actions', () => {
    render(Host, { open: true, withActions: false });
    expect(document.querySelector('.actions')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('opens and closes when the open prop changes', async () => {
    const { rerender } = render(Host, { open: false });
    await rerender({ open: true });
    expect(dialogElement().hasAttribute('open')).toBe(true);
    await rerender({ open: false });
    expect(dialogElement().hasAttribute('open')).toBe(false);
  });

  it('does not open an open dialog a second time', async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const { rerender } = render(Host, { open: true });
    await rerender({ dismissOnBackdrop: false });
    expect(showModal).toHaveBeenCalledTimes(1);
    showModal.mockRestore();
  });

  it('the close button closes it, reports it and updates the bound state', async () => {
    const user = userEvent.setup();
    const onclose = vi.fn();
    render(Host, { open: true, onclose });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(dialogElement().hasAttribute('open')).toBe(false);
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('open').textContent).toBe('closed');
  });

  it('closes when the platform closes it (Escape): state follows the dialog', async () => {
    const onclose = vi.fn();
    render(Host, { open: true, onclose });
    dialogElement().close();
    await vi.waitFor(() => {
      expect(screen.getByTestId('open').textContent).toBe('closed');
    });
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('can be opened again after it was closed', async () => {
    const user = userEvent.setup();
    const { rerender } = render(Host, { open: true });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await rerender({ open: true });
    expect(dialogElement().hasAttribute('open')).toBe(true);
  });

  it('a click on the backdrop (the dialog itself) closes it', async () => {
    const onclose = vi.fn();
    render(Host, { open: true, onclose });
    await fireEvent.click(dialogElement());
    expect(dialogElement().hasAttribute('open')).toBe(false);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('a click inside the content does not close it', async () => {
    const onclose = vi.fn();
    render(Host, { open: true, onclose });
    await fireEvent.click(screen.getByText('my-site.example'));
    expect(dialogElement().hasAttribute('open')).toBe(true);
    expect(onclose).not.toHaveBeenCalled();
  });

  it('ignores the backdrop when dismissOnBackdrop is off', async () => {
    render(Host, { open: true, dismissOnBackdrop: false });
    await fireEvent.click(dialogElement());
    expect(dialogElement().hasAttribute('open')).toBe(true);
  });

  it('the dialog has an accessible close button of at least 48 px (icon size class)', () => {
    render(Host, { open: true });
    expect(screen.getByRole('button', { name: 'Close' }).className).toContain('sc-btn--icon');
  });
});
