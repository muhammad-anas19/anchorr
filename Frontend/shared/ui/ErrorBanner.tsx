export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      style={{
        color: 'var(--err)',
        background: 'var(--err-soft)',
        border: '1px solid var(--err)',
        borderRadius: 7,
        padding: '8px 11px',
        fontSize: 12.5,
        margin: '0 0 10px',
      }}
    >
      {message}
    </p>
  );
}
