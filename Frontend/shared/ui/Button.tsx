import { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary';

const base: React.CSSProperties = {
  height: 34,
  padding: '0 14px',
  border: 0,
  borderRadius: 7,
  font: '500 13px/1 var(--font-sans)',
};

const variants: Record<Variant, React.CSSProperties> = {
  primary: { background: 'var(--btn-bg)', color: 'var(--btn-fg)' },
  secondary: { background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)' },
};

export function Button({
  variant = 'primary',
  style,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`anc-btn ${props.className ?? ''}`}
      style={{ ...base, ...variants[variant], opacity: props.disabled ? 0.5 : 1, ...style }}
    />
  );
}
