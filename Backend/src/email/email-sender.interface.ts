// The one thing the rest of the app knows about sending email. Same shape as StorageAdapter
// (Phase 3) and EmbeddingProvider (Phase 7): features depend on this interface, and swapping
// Gmail SMTP for SES, Postmark or Resend is one new class plus one line in EmailModule.
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface EmailMessage {
  to: string;
  subject: string;
  // Both, always. Some clients show only plain text, and spam filters score HTML-only mail
  // worse. The text part is also the one a human can read in a log.
  text: string;
  html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

// What actually sits in the queue: the message, plus an optional tag naming what it belongs
// to, so the worker can report delivery back to the feature that sent it.
export interface EmailJob {
  message: EmailMessage;
  tag?: import('./email-delivery-events').EmailTag;
}
