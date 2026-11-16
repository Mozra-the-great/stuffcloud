import { fireEvent, render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import Gallery from '../src/gallery/Gallery.svelte';
import { GALLERY_COLOURS, GALLERY_FONTS } from '../src/gallery/swatches.ts';
import { mountApp } from '../src/mount-app.ts';
import { toaster } from '../src/ui/toast.svelte.ts';
import { dataTransferInit, readAppFile, readCustomProperties } from './helpers.ts';

afterEach(() => {
  toaster.clear();
});

describe('component gallery', () => {
  it('has one heading per component group, in a main landmark with a level-1 title', () => {
    render(Gallery);
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Components' })).toBeTruthy();
    const groups = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(groups).toEqual([
      'Tokens',
      'Mascot',
      'Button, link button',
      'Input, select, checkbox',
      'Tabs',
      'Card, tile',
      'Dialog',
      'Toast',
      'Progress',
      'Code block',
      'File dropzone',
    ]);
  });

  it('renders every base component of issue #9', () => {
    render(Gallery);
    // button, link button
    expect(screen.getByRole('button', { name: 'Primary' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Link button' }).className).toContain('sc-btn');
    // input, select, checkbox
    expect(screen.getByLabelText('Name')).toBeTruthy();
    expect(screen.getByLabelText('Expires').tagName).toBe('SELECT');
    expect(screen.getByRole('checkbox', { name: 'Protect with a password' })).toBeTruthy();
    // tab
    expect(screen.getByRole('tablist', { name: 'Formats' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Convert tools' })).toBeTruthy();
    // card, tile
    expect(screen.getByText('Linked tile').closest('a')).not.toBeNull();
    expect(screen.getByText('Plain tile')).toBeTruthy();
    // dialog
    expect(document.querySelector('dialog')).not.toBeNull();
    // toast
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeTruthy();
    // progress
    expect(screen.getAllByRole('progressbar')).toHaveLength(3);
    // code block
    expect(screen.getByRole('region', { name: 'Deploy command' })).toBeTruthy();
    // dropzone
    expect(screen.getByRole('group', { name: 'drop PDFs here' })).toBeTruthy();
  });

  it('shows the whole cast: the main mascot big, nine animals small and one still pose', () => {
    render(Gallery);
    const section = screen.getByRole('heading', { name: 'Mascot' }).closest('section');
    if (section === null) {
      throw new Error('no mascot section');
    }
    const hosts = [...section.querySelectorAll<HTMLElement>('[data-mascot]')];
    expect(hosts).toHaveLength(11);
    expect(new Set(hosts.map((host) => host.dataset['mascot'])).size).toBe(9);
    expect(hosts.filter((host) => host.dataset['motion'] === 'still')).toHaveLength(1);
    // Decorative: hidden from assistive tech, so they add no names and no text of their own.
    for (const image of section.querySelectorAll('img')) {
      expect(image.getAttribute('alt')).toBe('');
      expect(image.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('gives every control an accessible name (the automatic part of the a11y baseline)', () => {
    render(Gallery);
    for (const role of ['button', 'link', 'checkbox', 'progressbar', 'tab'] as const) {
      for (const element of screen.getAllByRole(role, { hidden: true })) {
        const name =
          element.getAttribute('aria-label') ??
          (element as HTMLInputElement).labels?.[0]?.textContent.trim() ??
          element.textContent.trim();
        expect(name, `${role} without a name: ${element.outerHTML}`).not.toBe('');
      }
    }
    for (const field of document.querySelectorAll('input:not([hidden]), select')) {
      expect(
        (field as HTMLInputElement).labels?.length,
        `field without a label: ${field.outerHTML}`,
      ).toBeGreaterThan(0);
    }
  });

  it('lists only tokens that exist, and shows the three fonts', () => {
    const tokens = readCustomProperties('src/styles/tokens.css', 'src/styles/theme.css');
    for (const name of [...GALLERY_COLOURS, ...GALLERY_FONTS.map((font) => font.token)]) {
      expect(tokens.has(name), `${name} is not a token`).toBe(true);
    }
    render(Gallery);
    for (const name of GALLERY_COLOURS) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(GALLERY_FONTS.map((font) => font.token)).toEqual(['--pix', '--mono', '--sans']);
  });

  it('shows a toast of each kind from the buttons, errors in the alert region', async () => {
    const user = userEvent.setup();
    render(Gallery);
    const section = screen.getByRole('heading', { name: 'Toast' }).closest('section');
    if (section === null) {
      throw new Error('no toast section');
    }
    for (const kind of ['info', 'success', 'warn', 'error']) {
      await user.click(within(section).getByRole('button', { name: kind }));
    }
    const region = within(screen.getByRole('region', { name: 'Notifications' }));
    const status = within(region.getByRole('status'));
    expect(status.getByText('A info message')).toBeTruthy();
    expect(status.getByText('A success message')).toBeTruthy();
    expect(status.getByText('A warn message')).toBeTruthy();
    expect(within(region.getByRole('alert')).getByText('A error message')).toBeTruthy();
  });

  it('opens the dialog from its button and closes it from Cancel', async () => {
    const user = userEvent.setup();
    render(Gallery);
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete site' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('switches tabs and shows the dropped file names', async () => {
    const user = userEvent.setup();
    render(Gallery);
    await user.click(screen.getByRole('tab', { name: 'YAML' }));
    expect(screen.getByRole('tabpanel').textContent).toContain('YAML');

    const zone = screen.getByRole('group', { name: 'drop PDFs here' });
    await fireEvent.drop(
      zone,
      dataTransferInit([new File(['x'], 'a.pdf'), new File(['y'], 'b.pdf')]),
    );
    expect(zone.parentElement?.querySelector('p')?.textContent).toBe('a.pdf, b.pdf');
  });

  it('loads no external resource', () => {
    render(Gallery);
    for (const element of document.querySelectorAll('[src], link[href]')) {
      const url = element.getAttribute('src') ?? element.getAttribute('href') ?? '';
      expect(url).not.toMatch(/^(?:https?:)?\/\//);
    }
    expect(readAppFile('gallery.html')).not.toMatch(/(?:src|href)=["']https?:/);
  });
});

describe('mounting', () => {
  it('mounts any root component into the element, the gallery included', () => {
    const target = document.createElement('div');
    target.id = 'gallery-root';
    document.body.append(target);
    const mounted = mountApp('gallery-root', document, Gallery);
    expect(target.querySelector('h1')?.textContent).toBe('Components');
    mounted.destroy();
    expect(target.querySelector('h1')).toBeNull();
    target.remove();
  });

  it('the gallery entry mounts into #app', async () => {
    const target = document.createElement('div');
    target.id = 'app';
    document.body.append(target);
    await import('../src/gallery/main.ts');
    expect(target.querySelector('h1')?.textContent).toBe('Components');
    target.remove();
  });
});
