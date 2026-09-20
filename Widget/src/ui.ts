export interface WidgetUI {
  appendMessage(role: 'customer' | 'assistant' | 'system', text: string): void;
  onSubmit(handler: (question: string) => void): void;
  setSending(sending: boolean): void;
}

// `:host { all: initial; }` plus a Shadow DOM (rather than a plain injected <style> tag) is
// the real fix for host-page isolation (Q9): none of the host page's own CSS can reach in
// here, and none of these rules can leak out and clobber the host page's own styling.
const STYLES = `
  :host { all: initial; }
  .bubble { position: fixed; bottom: 20px; right: 20px; width: 56px; height: 56px; border-radius: 50%;
    background: #4f46e5; color: white; display: flex; align-items: center; justify-content: center;
    cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.15); font-family: sans-serif; font-size: 24px;
    z-index: 999999; border: none; }
  .panel { position: fixed; bottom: 88px; right: 20px; width: 320px; max-height: 440px;
    display: none; flex-direction: column; background: white; border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.2); font-family: sans-serif; overflow: hidden; z-index: 999999; }
  .panel.open { display: flex; }
  .messages { flex: 1; overflow-y: auto; padding: 12px; font-size: 14px; }
  .message { margin-bottom: 8px; padding: 8px 10px; border-radius: 8px; max-width: 85%; word-wrap: break-word; }
  .message.customer { background: #4f46e5; color: white; margin-left: auto; }
  .message.assistant { background: #f3f4f6; color: #111827; }
  .message.system { background: transparent; color: #9ca3af; font-style: italic; font-size: 12px; text-align: center; max-width: 100%; }
  .input-row { display: flex; border-top: 1px solid #e5e7eb; padding: 8px; }
  .input { flex: 1; border: 1px solid #d1d5db; border-radius: 6px; padding: 6px 8px; font-size: 14px; min-width: 0; }
  .send { margin-left: 8px; background: #4f46e5; color: white; border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  .send:disabled { opacity: 0.5; cursor: default; }
`;

export function buildWidgetUI(): WidgetUI {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = STYLES;
  root.appendChild(style);

  const bubble = document.createElement('button');
  bubble.className = 'bubble';
  bubble.setAttribute('aria-label', 'Open chat');
  bubble.textContent = '💬';
  root.appendChild(bubble);

  const panel = document.createElement('div');
  panel.className = 'panel';

  const messages = document.createElement('div');
  messages.className = 'messages';

  const inputRow = document.createElement('div');
  inputRow.className = 'input-row';
  const input = document.createElement('input');
  input.className = 'input';
  input.type = 'text';
  input.placeholder = 'Ask a question…';
  const send = document.createElement('button');
  send.className = 'send';
  send.textContent = 'Send';
  inputRow.appendChild(input);
  inputRow.appendChild(send);

  panel.appendChild(messages);
  panel.appendChild(inputRow);
  root.appendChild(panel);

  bubble.addEventListener('click', () => panel.classList.toggle('open'));

  let submitHandler: ((question: string) => void) | null = null;
  function trigger(): void {
    const value = input.value.trim();
    if (!value || !submitHandler) return;
    submitHandler(value);
    input.value = '';
  }
  send.addEventListener('click', trigger);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') trigger();
  });

  return {
    appendMessage(role, text) {
      const el = document.createElement('div');
      el.className = `message ${role}`;
      el.textContent = text;
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
    },
    onSubmit(handler) {
      submitHandler = handler;
    },
    setSending(sending) {
      send.disabled = sending;
      input.disabled = sending;
    },
  };
}
