import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import Checkbox from '../src/ui/Checkbox.svelte';
import { describedBy, hasText } from '../src/ui/field-ids.ts';

describe('hasText', () => {
  it('is true for any non-empty string only', () => {
    expect(hasText('a')).toBe(true);
    expect(hasText(' ')).toBe(true);
    expect(hasText('')).toBe(false);
    expect(hasText(undefined)).toBe(false);
  });
});

describe('describedBy', () => {
  it('joins the present ids with a space', () => {
    expect(describedBy('a', 'b')).toBe('a b');
    expect(describedBy('a', undefined)).toBe('a');
    expect(describedBy(undefined, 'b')).toBe('b');
  });

  it('is undefined when there is no id', () => {
    expect(describedBy()).toBeUndefined();
    expect(describedBy(undefined, '')).toBeUndefined();
  });
});

describe('Checkbox', () => {
  it('is a real checkbox named by its label', () => {
    render(Checkbox, { label: 'Protect with a password' });
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Protect with a password' });
    expect(box.checked).toBe(false);
  });

  it('toggles by click on the box or on the label text, and with the space key', async () => {
    const user = userEvent.setup();
    render(Checkbox, { label: 'Agree' });
    const box = screen.getByRole<HTMLInputElement>('checkbox');
    await user.click(box);
    expect(box.checked).toBe(true);
    await user.click(screen.getByText('Agree'));
    expect(box.checked).toBe(false);
    box.focus();
    await user.keyboard(' ');
    expect(box.checked).toBe(true);
  });

  it('starts checked when asked to and passes attributes through', () => {
    render(Checkbox, { label: 'Agree', checked: true, disabled: true, name: 'agree' });
    const box = screen.getByRole<HTMLInputElement>('checkbox');
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(box.name).toBe('agree');
  });
});
