import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import Checkbox from '../src/ui/Checkbox.svelte';
import { describedBy, hasText } from '../src/ui/field-ids.ts';
import Input from '../src/ui/Input.svelte';
import Select from '../src/ui/Select.svelte';
import type { SelectOption } from '../src/ui/types.ts';

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

describe('Input', () => {
  it('labels the field (no placeholder-only inputs)', () => {
    render(Input, { label: 'Name' });
    const input = screen.getByLabelText('Name');
    expect(input.tagName).toBe('INPUT');
    expect(input.className).toBe('sc-field');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });

  it('shows the value and updates it while typing', async () => {
    const user = userEvent.setup();
    render(Input, { label: 'Name', value: 'abc' });
    const input = screen.getByLabelText<HTMLInputElement>('Name');
    expect(input.value).toBe('abc');
    await user.type(input, 'd');
    expect(input.value).toBe('abcd');
  });

  it('links the hint through aria-describedby', () => {
    render(Input, { label: 'Name', hint: 'Letters only' });
    const input = screen.getByLabelText('Name');
    const hint = screen.getByText('Letters only');
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('marks the field invalid and links the error before the hint', () => {
    render(Input, { label: 'Name', hint: 'Letters only', error: 'Too short' });
    const input = screen.getByLabelText('Name');
    const error = screen.getByText('Too short');
    const hint = screen.getByText('Letters only');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(`${error.id} ${hint.id}`);
  });

  it('treats empty hint and error texts as absent', () => {
    render(Input, { label: 'Name', hint: '', error: '' });
    expect(screen.getByLabelText('Name').getAttribute('aria-describedby')).toBeNull();
    expect(document.querySelector('.sc-fld__hint')).toBeNull();
    expect(document.querySelector('.sc-fld__error')).toBeNull();
  });

  it('uses a given id and passes other attributes through', () => {
    render(Input, { label: 'Email', id: 'mail', type: 'email', required: true, disabled: true });
    const input = screen.getByLabelText<HTMLInputElement>('Email');
    expect(input.id).toBe('mail');
    expect(input.type).toBe('email');
    expect(input.required).toBe(true);
    expect(input.disabled).toBe(true);
  });

  it('gives two inputs different ids', () => {
    render(Input, { label: 'A' });
    render(Input, { label: 'B' });
    expect(screen.getByLabelText('A').id).not.toBe(screen.getByLabelText('B').id);
  });
});

describe('Select', () => {
  const options: readonly SelectOption[] = [
    { value: 'one', label: 'One day' },
    { value: 'seven', label: 'Seven days' },
    { value: 'never', label: 'Never', disabled: true },
  ];

  it('renders a labelled native select with its options', () => {
    render(Select, { label: 'Expires', options, value: 'seven' });
    const select = screen.getByLabelText<HTMLSelectElement>('Expires');
    expect(select.tagName).toBe('SELECT');
    expect(select.className).toBe('sc-field');
    expect(select.value).toBe('seven');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'One day',
      'Seven days',
      'Never',
    ]);
    expect(screen.getByRole<HTMLOptionElement>('option', { name: 'Never' }).disabled).toBe(true);
  });

  it('changes the value with the keyboard or mouse', async () => {
    const user = userEvent.setup();
    render(Select, { label: 'Expires', options, value: 'one' });
    const select = screen.getByLabelText<HTMLSelectElement>('Expires');
    await user.selectOptions(select, 'seven');
    expect(select.value).toBe('seven');
  });

  it('links hint and error and marks the select invalid', () => {
    render(Select, { label: 'Expires', options, hint: 'Pick one', error: 'Required' });
    const select = screen.getByLabelText('Expires');
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.getAttribute('aria-describedby')).toBe(
      `${screen.getByText('Required').id} ${screen.getByText('Pick one').id}`,
    );
  });

  it('describes the select by the hint alone or the error alone', () => {
    const { unmount } = render(Select, { label: 'Expires', options, hint: 'Pick one' });
    const select = screen.getByLabelText('Expires');
    expect(select.getAttribute('aria-describedby')).toBe(screen.getByText('Pick one').id);
    expect(select.getAttribute('aria-invalid')).toBeNull();
    unmount();
    render(Select, { label: 'Expires', options, error: 'Required' });
    expect(screen.getByLabelText('Expires').getAttribute('aria-describedby')).toBe(
      screen.getByText('Required').id,
    );
  });

  it('follows a changed option list', async () => {
    const { rerender } = render(Select, { label: 'Expires', options, value: 'one' });
    await rerender({ options: [{ value: 'one', label: 'One day', disabled: true }] });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole<HTMLOptionElement>('option').disabled).toBe(true);
  });

  it('has no description and is valid without hint and error', () => {
    render(Select, { label: 'Expires', options, id: 'exp' });
    const select = screen.getByLabelText('Expires');
    expect(select.id).toBe('exp');
    expect(select.getAttribute('aria-invalid')).toBeNull();
    expect(select.getAttribute('aria-describedby')).toBeNull();
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
