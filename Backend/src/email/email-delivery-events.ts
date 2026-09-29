import { Injectable, Logger } from '@nestjs/common';

// Lets a feature learn what happened to an email it enqueued, without EmailModule knowing
// that feature exists. InvitationsService registers a handler for 'invitation'; the email
// worker reports into it. The dependency points one way: features → email, never back.
export interface EmailTag {
  type: string;
  ref: Record<string, string | number>;
}

export type DeliveryOutcome =
  | { status: 'sent' }
  | { status: 'retrying'; attempt: number; maxAttempts: number; error: string }
  | { status: 'failed'; error: string };

type Handler = (ref: EmailTag['ref'], outcome: DeliveryOutcome) => Promise<void>;

@Injectable()
export class EmailDeliveryEvents {
  private readonly logger = new Logger(EmailDeliveryEvents.name);
  private readonly handlers = new Map<string, Handler>();

  register(type: string, handler: Handler): void {
    this.handlers.set(type, handler);
  }

  // Never throws. Delivery bookkeeping is a side effect of sending, not part of it: if
  // recording "sent" failed and that error reached the worker, the job would be marked failed
  // and RETRIED — and the retry would send the email a second time. The email already went
  // out; the only acceptable consequence of a bookkeeping failure is a stale status, logged.
  async report(tag: EmailTag | undefined, outcome: DeliveryOutcome): Promise<void> {
    if (!tag) return;
    const handler = this.handlers.get(tag.type);
    if (!handler) return;
    try {
      await handler(tag.ref, outcome);
    } catch (error) {
      this.logger.error(`Could not record "${outcome.status}" for ${tag.type} ${JSON.stringify(tag.ref)}: ${(error as Error).message}`);
    }
  }
}
