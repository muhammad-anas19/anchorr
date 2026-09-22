import { InputHTMLAttributes } from 'react';

export function TextField(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{ padding: 8, border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, ...props.style }}
    />
  );
}
