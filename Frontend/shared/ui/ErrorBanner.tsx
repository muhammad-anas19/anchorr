export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" style={{ color: '#dc2626', fontSize: 14, margin: 0 }}>
      {message}
    </p>
  );
}
