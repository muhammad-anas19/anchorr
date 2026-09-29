import { MigrationInterface, QueryRunner } from 'typeorm';

// Records what happened to the invitation email, reported back by the email worker.
//
// "sent" means the recipient's mail server ACCEPTED the message (SMTP 250), which is the most
// an SMTP sender ever learns. It is not "delivered to the inbox" and not "read": spam folders,
// later bounces and opens are invisible over plain SMTP. Transactional providers (SES,
// Postmark) report those through webhooks — the natural next step, and why the UI says
// "sent to mail server" rather than "delivered".
export class AddEmailDeliveryToInvitations1790770000000 implements MigrationInterface {
  name = 'AddEmailDeliveryToInvitations1790770000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE invitations
        ADD COLUMN email_status varchar(16) NOT NULL DEFAULT 'queued'
          CONSTRAINT "CHK_invitations_email_status" CHECK (email_status IN ('queued', 'sent', 'failed')),
        ADD COLUMN email_sent_at timestamptz,
        ADD COLUMN email_last_error text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE invitations DROP COLUMN email_status, DROP COLUMN email_sent_at, DROP COLUMN email_last_error
    `);
  }
}
