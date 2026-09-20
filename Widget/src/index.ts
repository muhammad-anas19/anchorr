import { getOrCreateSessionId } from './session';
import { connectWidgetSocket, sendQuestion } from './socket';
import { buildWidgetUI } from './ui';

export interface AnchorWidgetConfig {
  publicKey: string;
  serverUrl: string;
}

function init(config: AnchorWidgetConfig): void {
  const sessionId = getOrCreateSessionId();
  const ui = buildWidgetUI();

  const socket = connectWidgetSocket(
    config.serverUrl,
    config.publicKey,
    sessionId,
    (payload) => {
      ui.setSending(false);
      ui.appendMessage('assistant', payload.answer);
    },
    (message) => {
      ui.setSending(false);
      ui.appendMessage('system', message);
    },
  );

  ui.onSubmit((question) => {
    ui.appendMessage('customer', question);
    ui.setSending(true);
    sendQuestion(socket, question);
  });
}

declare global {
  interface Window {
    Anchor: { init: typeof init };
  }
}

window.Anchor = { init };
