import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EMAIL_SENDER, EmailJob, EmailSender } from './email-sender.interface';
import { EmailDeliveryEvents } from './email-delivery-events';
import { EMAIL_QUEUE } from './email.constants';

// Delivery happens here, off the request path. SMTP to Gmail takes 1-3 s and fails transiently
// (rate limits, TLS resets, a server hiccup); retrying inside an HTTP request would make the
// inviter wait for all of that. The queue retries with backoff instead (Phase 4's machinery).
//
// Delivery is at-least-once (Phase 4): if the worker dies after SMTP accepted the message but
// before the job is marked complete, the job is redelivered and the email is sent twice. For an
// invitation that is harmless — both copies carry the same token — which is why no dedupe is
// attempted here.
@Processor(EMAIL_QUEUE, { concurrency: 2 })
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    private readonly deliveryEvents: EmailDeliveryEvents,
  ) {
    super();
  }

  async process(job: Job<EmailJob>): Promise<void> {
    await this.sender.send(job.data.message);
    // After the send, outside its failure path: report() never throws (see its comment).
    await this.deliveryEvents.report(job.data.tag, { status: 'sent' });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<EmailJob>, error: Error): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;
    const final = job.attemptsMade >= maxAttempts;
    this.logger.error(
      `Email to ${job.data.message.to} failed (attempt ${job.attemptsMade}${final ? ', giving up' : ''}): ${error.message}`,
    );
    await this.deliveryEvents.report(
      job.data.tag,
      final
        ? { status: 'failed', error: error.message }
        : { status: 'retrying', attempt: job.attemptsMade, maxAttempts, error: error.message },
    );
  }
}
