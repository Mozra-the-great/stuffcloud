export type ButtonVariant = 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'default' | 'compact' | 'icon';

export interface ButtonStyle {
  readonly variant?: ButtonVariant | undefined;
  readonly size?: ButtonSize | undefined;
  readonly wide?: boolean | undefined;
}

/** Class list shared by `Button` and `LinkButton` (styles live in button.css). */
export function buttonClasses({
  variant = 'primary',
  size = 'default',
  wide = false,
}: ButtonStyle): string {
  const classes = ['sc-btn'];
  if (variant !== 'primary') {
    classes.push(`sc-btn--${variant}`);
  }
  if (size !== 'default') {
    classes.push(`sc-btn--${size}`);
  }
  if (wide) {
    classes.push('sc-btn--wide');
  }
  return classes.join(' ');
}
