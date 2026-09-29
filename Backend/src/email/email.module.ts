import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { EMAIL_SENDER, EmailSender } from './email-sender.interface';
import { SmtpEmailSender } from './smtp-email-sender';
import { ConsoleEmailSender } from './console-email-sender';
import { EMAIL_QUEUE } from './email.constants';
import { EmailProcessor } from './email.processor';
import { EmailService } from './email.service';
import { EmailDeliveryEvents } from './email-delivery-events';

// Picks the sender once, at boot:
//   SMTP_HOST set          → real SMTP
//   unset, not production  → print to the log (fine on a laptop)
//   unset, production      → refuse to start
// The last rule is the important one. Silently falling back to "print it" in production would
// look like a working system — invitations "sent", no errors — while no email ever arrives and
// every token lands in the logs. Failing at boot makes a missing config a deploy error.
function createSender(config: ConfigService): EmailSender {
  // Empty strings count as unset: `SMTP_HOST=` in .env arrives as '' rather than undefined.
  const host = config.get<string>('SMTP_HOST') || undefined;
  if (host) {
    const required = ['SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'].filter((key) => !config.get<string>(key));
    if (required.length > 0) {
      throw new Error(`SMTP_HOST is set but ${required.join(', ')} ${required.length > 1 ? 'are' : 'is'} missing.`);
    }
    // "Anchor" alone is a display name, not a sender. Caught here, at boot, rather than as a
    // rejected or rewritten message on the first real send.
    const from = config.get<string>('MAIL_FROM')!;
    if (!/^[^<>]*<[^<>\s@]+@[^<>\s@]+>$|^[^<>\s@]+@[^<>\s@]+$/.test(from.trim())) {
      throw new Error(`MAIL_FROM must include an address, e.g. "Anchor <you@gmail.com>" — got "${from}".`);
    }
    return new SmtpEmailSender({
      host,
      port: Number(config.get<string>('SMTP_PORT') || 465),
      user: config.get<string>('SMTP_USER')!,
      pass: config.get<string>('SMTP_PASS')!,
      from: config.get<string>('MAIL_FROM')!,
    });
  }

  if (config.get<string>('NODE_ENV') === 'production') {
    throw new Error('No SMTP configured (SMTP_HOST is unset). Refusing to start in production without email delivery.');
  }
  new Logger('EmailModule').warn('SMTP_HOST is unset — emails will be printed to the log instead of sent.');
  return new ConsoleEmailSender();
}

@Module({
  imports: [ConfigModule, BullModule.registerQueue({ name: EMAIL_QUEUE })],
  providers: [
    { provide: EMAIL_SENDER, inject: [ConfigService], useFactory: createSender },
    EmailProcessor,
    EmailService,
    EmailDeliveryEvents,
  ],
  exports: [EmailService, EmailDeliveryEvents],
})
export class EmailModule {}
