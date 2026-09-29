import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EmailJob, EmailMessage } from './email-sender.interface';
import { EmailTag } from './email-delivery-events';
import { EMAIL_QUEUE } from './email.constants';

// What features call. It only enqueues; EmailProcessor delivers.
@Injectable()
export class EmailService {
  constructor(@InjectQueue(EMAIL_QUEUE) private readonly queue: Queue<EmailJob>) {}

  async enqueue(message: EmailMessage, tag?: EmailTag): Promise<void> {
    await this.queue.add('send', { message, tag }, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 }, // 10 s, 20 s, 40 s, 80 s
      // The job payload is the rendered email, and an invitation email contains a live token.
      // A completed job has no further use, so it is deleted rather than left sitting in Redis;
      // a failed one is kept a day for diagnosis, then dropped. Tokens expire in 7 days anyway.
      removeOnComplete: true,
      removeOnFail: { age: 24 * 60 * 60 },
    });
  }
}
