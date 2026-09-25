'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useWorkspace } from '../../shared/workspace/WorkspaceContext';
import { ErrorBanner } from '../../shared/ui/ErrorBanner';
import { notifyError, notifySuccess } from '../../shared/ui/toast';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { getWidgetSettings, updateAllowedOrigins, WidgetSettings } from './api';

const ORIGIN_PATTERN = /^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/;

export function WidgetSettingsPage() {
  const { workspaceId, role } = useWorkspace();
  const canEdit = role === 'owner';
  const [settings, setSettings] = useState<WidgetSettings | null>(null);
  const [newOrigin, setNewOrigin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getWidgetSettings(workspaceId)
      .then(setSettings)
      .catch((err) => notifyError(err, 'Could not load widget settings.'));
  }, [workspaceId]);

  async function handleAddOrigin(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const origin = newOrigin.trim();
    if (!ORIGIN_PATTERN.test(origin)) {
      // Stays an inline message rather than a toast: it belongs next to the field that is
      // wrong, and it is a validation hint, not the result of an operation.
      setError('Enter an origin like https://example.com — no path, no trailing slash.');
      return;
    }
    if (!settings) return;
    try {
      const updated = await updateAllowedOrigins(workspaceId, [...settings.allowedOrigins, origin]);
      setSettings(updated);
      setNewOrigin('');
      notifySuccess(`${origin} can now load the widget.`);
    } catch (err) {
      notifyError(err, 'Could not update the allowlist.');
    }
  }

  async function handleRemoveOrigin(origin: string) {
    if (!settings) return;
    setError(null);
    try {
      const updated = await updateAllowedOrigins(
        workspaceId,
        settings.allowedOrigins.filter((o) => o !== origin),
      );
      setSettings(updated);
      notifySuccess(
        updated.allowedOrigins.length === 0
          ? `${origin} removed — the widget now loads nowhere, since an empty allowlist fails closed.`
          : `${origin} removed from the allowlist.`,
      );
    } catch (err) {
      notifyError(err, 'Could not update the allowlist.');
    }
  }

  function copySnippet() {
    if (!settings) return;
    const snippet = embedSnippet(settings.publicKey);
    navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  if (!settings) {
    return (
      <div style={{ padding: '28px 32px' }}>
        <ErrorBanner message={error} />
        {!error && <p style={{ color: '#9a9aa2', fontSize: 13 }}>Loading…</p>}
      </div>
    );
  }

  return (
    <div style={{ padding: '28px 32px 48px', maxWidth: 720 }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>Widget</h1>
      <p style={{ margin: '6px 0 22px', fontSize: 14, color: '#6b6b73' }}>
        Copy one script tag onto your site, and control which domains it's allowed to run from.
      </p>

      <ErrorBanner message={error} />

      <section style={{ background: 'white', border: '1px solid #e7e7e4', borderRadius: 10, padding: 18, marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Embed snippet</div>
        <pre
          style={{
            background: '#fafafa',
            border: '1px solid #e7e7e4',
            borderRadius: 8,
            padding: 12,
            fontSize: 12,
            overflowX: 'auto',
            margin: 0,
          }}
        >
          {embedSnippet(settings.publicKey)}
        </pre>
        <Button variant="secondary" onClick={copySnippet} style={{ marginTop: 10, fontSize: 12.5 }}>
          {copied ? 'Copied!' : 'Copy snippet'}
        </Button>
      </section>

      <section style={{ background: 'white', border: '1px solid #e7e7e4', borderRadius: 10, padding: 18 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Domain allowlist</div>
        <p style={{ margin: '0 0 12px', fontSize: 12.5, color: '#6b6b73' }}>
          Only pages served from these origins may connect using this workspace's widget.
        </p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: canEdit ? 14 : 0 }}>
          {settings.allowedOrigins.length === 0 && (
            <span style={{ fontSize: 12.5, color: '#9a9aa2' }}>No origins configured yet — the widget accepts connections from nowhere.</span>
          )}
          {settings.allowedOrigins.map((origin) => (
            <span
              key={origin}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 8px',
                borderRadius: 6,
                background: '#fafafa',
                border: '1px solid #e7e7e4',
                fontSize: 12,
                fontFamily: 'monospace',
              }}
            >
              {origin}
              {canEdit && (
                <span
                  onClick={() => handleRemoveOrigin(origin)}
                  style={{ color: '#9a9aa2', cursor: 'pointer' }}
                >
                  ×
                </span>
              )}
            </span>
          ))}
        </div>
        {canEdit && (
          <form onSubmit={handleAddOrigin} style={{ display: 'flex', gap: 8 }}>
            <TextField
              placeholder="https://example.com"
              value={newOrigin}
              onChange={(e) => setNewOrigin(e.target.value)}
              style={{ flex: 1 }}
            />
            <Button type="submit">Add</Button>
          </form>
        )}
        {!canEdit && (
          <p style={{ fontSize: 12, color: '#9a9aa2', marginTop: 10 }}>Only the workspace owner can change the allowlist.</p>
        )}
      </section>
    </div>
  );
}

function embedSnippet(publicKey: string): string {
  return `<script src="https://cdn.example.com/widget.js"></script>\n<script>\n  window.Anchor.init({ publicKey: "${publicKey}", serverUrl: "https://your-backend.example.com" });\n</script>`;
}
