import { InputHTMLAttributes } from 'react';

export function TextField(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        height: 34,
        padding: '0 11px',
        border: '1px solid var(--border-2)',
        borderRadius: 7,
        background: 'var(--surface)',
        color: 'var(--fg)',
        fontSize: 13,
        outline: 'none',
        ...props.style,
      }}
    />
  );
}
