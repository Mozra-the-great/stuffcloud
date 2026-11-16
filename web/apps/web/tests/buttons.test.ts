import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { buttonClasses } from '../src/ui/button-classes.ts';
import Button from '../src/ui/Button.svelte';
import LinkButton from '../src/ui/LinkButton.svelte';
import { readAppFile } from './helpers.ts';
import { textSnippet } from './helpers.ts';

describe('buttonClasses', () => {
  it('is just the base class for the default look', () => {
    expect(buttonClasses({})).toBe('sc-btn');
    expect(buttonClasses({ variant: 'primary', size: 'default', wide: false })).toBe('sc-btn');
  });

  it('adds one modifier per non-default option, in a fixed order', () => {
    expect(buttonClasses({ variant: 'ghost' })).toBe('sc-btn sc-btn--ghost');
    expect(buttonClasses({ variant: 'danger' })).toBe('sc-btn sc-btn--danger');
    expect(buttonClasses({ size: 'compact' })).toBe('sc-btn sc-btn--compact');
    expect(buttonClasses({ size: 'icon' })).toBe('sc-btn sc-btn--icon');
    expect(buttonClasses({ wide: true })).toBe('sc-btn sc-btn--wide');
    expect(buttonClasses({ variant: 'ghost', size: 'icon', wide: true })).toBe(
      'sc-btn sc-btn--ghost sc-btn--icon sc-btn--wide',
    );
  });
});

describe('Button', () => {
  it('renders a real button that is type=button unless told otherwise', () => {
    render(Button, { children: textSnippet('Save') });
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toBe('sc-btn');
  });

  it('passes type, disabled and aria attributes through', () => {
    render(Button, {
      type: 'submit',
      disabled: true,
      'aria-label': 'Send',
      children: textSnippet('x'),
    });
    const button = screen.getByRole('button', { name: 'Send' });
    expect(button.getAttribute('type')).toBe('submit');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('applies the variant, size and wide classes', () => {
    render(Button, {
      variant: 'danger',
      size: 'compact',
      wide: true,
      children: textSnippet('Delete'),
    });
    expect(screen.getByRole('button').className).toBe(
      'sc-btn sc-btn--danger sc-btn--compact sc-btn--wide',
    );
  });

  it('calls onclick when clicked and not when disabled', async () => {
    const user = userEvent.setup();
    const onclick = vi.fn();
    const { rerender } = render(Button, { onclick, children: textSnippet('Go') });
    await user.click(screen.getByRole('button'));
    expect(onclick).toHaveBeenCalledTimes(1);

    await rerender({ disabled: true });
    await user.click(screen.getByRole('button'));
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  it('is reachable and operable with the keyboard', async () => {
    const user = userEvent.setup();
    const onclick = vi.fn();
    render(Button, { onclick, children: textSnippet('Go') });
    await user.tab();
    expect(screen.getByRole('button')).toBe(document.activeElement);
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onclick).toHaveBeenCalledTimes(2);
  });
});

describe('LinkButton', () => {
  it('renders a link with the button look', () => {
    render(LinkButton, { href: '/tools', children: textSnippet('Tools') });
    const link = screen.getByRole('link', { name: 'Tools' });
    expect(link.getAttribute('href')).toBe('/tools');
    expect(link.className).toBe('sc-btn');
  });

  it('applies variant, size and wide and passes anchor attributes through', () => {
    render(LinkButton, {
      props: {
        href: 'https://example.org',
        variant: 'ghost',
        size: 'compact',
        wide: true,
        rel: 'noopener noreferrer',
        target: '_blank',
        children: textSnippet('External'),
      },
    });
    const link = screen.getByRole('link');
    expect(link.className).toBe('sc-btn sc-btn--ghost sc-btn--compact sc-btn--wide');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
  });
});

describe('button.css (design: .btn)', () => {
  const css = readAppFile('src/ui/button.css');

  it('keeps the touch target sizes of the design', () => {
    expect(css).toContain('min-height: var(--control-h)');
    expect(css).toContain('min-height: var(--target-min)');
    expect(css).toContain('width: var(--target-icon)');
  });

  it('dims disabled buttons and handles forced colours', () => {
    expect(css).toMatch(/\.sc-btn:disabled\s*\{[^}]*opacity: 0\.4/);
    expect(css).toContain('@media (forced-colors: active)');
  });
});
