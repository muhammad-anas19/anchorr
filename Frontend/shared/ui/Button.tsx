import { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary';

const base: React.CSSProperties = {
  padding: '8px 16px',
  border: 'none',
  borderRadius: 6,
  fontSize: 14,
};

const variants: Record<Variant, React.CSSProperties> = {
  primary: { background: '#4f46e5', color: 'white' },
  secondary: { background: '#f3f4f6', color: '#111827' },
};

export function Button({
  variant = 'primary',
  style,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      style={{ ...base, ...variants[variant], opacity: props.disabled ? 0.6 : 1, ...style }}
    />
  );
}
