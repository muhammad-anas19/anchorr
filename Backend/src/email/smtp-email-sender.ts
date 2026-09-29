import { Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { EmailMessage, EmailSender } from './email-sender.interface';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

// Real delivery over SMTP. Configured for Gmail in development (smtp.gmail.com:465 with an App
// Password), but nothing here is Gmail-specific.
//
// Gmail is fine for learning and wrong for production: ~500 recipients/day, and it sends from
// a personal address. Production uses a transactional provider (SES, Postmark, Resend) on the
// product's own domain with SPF/DKIM/DMARC records, so mail is authenticated as coming from
// that domain and lands in inboxes rather than spam.
export class SmtpEmailSender implements EmailSender {
  private readonly logger = new Logger(SmtpEmailSender.name);
  private readonly transport: Transporter;

  constructor(private readonly config: SmtpConfig) {
    this.transport = createTransport({
      host: config.host,
      port: config.port,
      // Port 465 is TLS from the first byte; 587 starts in plain text and upgrades (STARTTLS).
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
      // One long-lived connection reused across messages instead of a TLS handshake per email.
      pool: true,
      // Without these, a hung SMTP server holds a worker slot indefinitely.
      connectionTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    const info = await this.transport.sendMail({ from: this.config.from, ...message });
    // The recipient is logged, the body is not: invitation bodies contain a live token.
    this.logger.log(`Sent "${message.subject}" to ${message.to} (${info.messageId})`);
  }
}
