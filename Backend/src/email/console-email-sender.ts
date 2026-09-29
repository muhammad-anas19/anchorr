import { Logger } from '@nestjs/common';
import { EmailMessage, EmailSender } from './email-sender.interface';

// Development fallback when no SMTP credentials are configured: prints the message, including
// the plain-text body (and therefore any invitation link), to the server log. That is exactly
// why EmailModule refuses to use this in production — logs are read by far more people and
// systems than an inbox is, and a logged token is a usable token.
export class ConsoleEmailSender implements EmailSender {
  private readonly logger = new Logger(ConsoleEmailSender.name);

  async send(message: EmailMessage): Promise<void> {
    this.logger.warn(
      `No SMTP configured — email NOT sent, printed instead.\n` +
        `  To: ${message.to}\n  Subject: ${message.subject}\n\n${message.text}\n`,
    );
  }
}
