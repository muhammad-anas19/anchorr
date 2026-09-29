import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.module';
import { User } from '../src/database/entities/user.entity';
import { Membership } from '../src/database/entities/membership.entity';
import { MembershipRole } from '../src/database/entities/membership-role.enum';
import { EMAIL_SENDER, EmailMessage, EmailSender } from '../src/email/email-sender.interface';
import { EMAIL_QUEUE } from '../src/email/email.constants';
import { PermissionsService } from '../src/modules/tenancy/permissions.service';
import { hashToken } from '../src/modules/invitations/invitations.service';
import { EmailDeliveryEvents } from '../src/email/email-delivery-events';
import { resetDatabase } from './helpers/reset-database';

// Email is the one substituted dependency: a capturing sender instead of SMTP, so no test ever
// emails a real address. Everything else is real — Postgres, Redis, and the BullMQ email queue,
// so a captured message proves it travelled enqueue → worker → sender, not just that enqueue ran.
class CapturingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

describe('Invitations (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let redis: Redis;
  let permissions: PermissionsService;
  const mailbox = new CapturingEmailSender();
  let ownerToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMAIL_SENDER)
      .useValue(mailbox)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    jwtService = moduleRef.get(JwtService);
    redis = moduleRef.get(REDIS_CLIENT);
    permissions = moduleRef.get(PermissionsService);
    // Leftover jobs from an earlier, interrupted run would otherwise land in this run's mailbox.
    await moduleRef.get<Queue>(getQueueToken(EMAIL_QUEUE)).obliterate({ force: true });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    // Rate-limit counters are keyed by workspace/invitation id, and RESTART IDENTITY hands the
    // same ids to the next test while Redis keeps the counters — the Phase 14 lesson again.
    const keys = [...(await redis.keys('invite-sends:*')), ...(await redis.keys('invite-resend:*'))];
    if (keys.length) await redis.del(...keys);
    mailbox.sent.length = 0;

    ownerToken = (await register('owner@northwind.com', 'Northwind')).accessToken;
  });

  async function register(email: string, workspaceName: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'correct-horse-battery', workspaceName })
      .expect(201);
    return res.body as { accessToken: string };
  }

  async function addMember(email: string, role: MembershipRole, workspaceId = 1): Promise<string> {
    const user = await dataSource.getRepository(User).save({ email, passwordHash: 'unused' });
    await dataSource.getRepository(Membership).save({ workspaceId, userId: user.id, role });
    return jwtService.signAsync({ sub: user.id });
  }

  function invite(body: object, token = ownerToken, workspaceId = 1) {
    return request(app.getHttpServer())
      .post(`/workspaces/${workspaceId}/invitations`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  async function waitForEmails(to: string, count = 1): Promise<EmailMessage[]> {
    // Measured delivery through the real queue is ~50-65 ms, so 10 s is not "waiting for a slow
    // queue" — hitting it means the job was never delivered to THIS mailbox (another worker took
    // it). The error lists everything that did arrive, so such a failure explains itself.
    for (let i = 0; i < 200; i++) {
      const matching = mailbox.sent.filter((m) => m.to === to);
      if (matching.length >= count) return matching;
      await new Promise((r) => setTimeout(r, 50));
    }
    const queue = app.get<Queue>(getQueueToken(EMAIL_QUEUE));
    throw new Error(
      `Expected ${count} email(s) to ${to} within 10 s, got ${mailbox.sent.filter((m) => m.to === to).length}. ` +
        `Mailbox holds: [${mailbox.sent.map((m) => m.to).join(', ')}]. ` +
        `Queue: ${JSON.stringify(await queue.getJobCounts())}, prefix ${process.env.QUEUE_PREFIX}.`,
    );
  }

  function tokenFrom(message: EmailMessage): string {
    const match = /#token=([A-Za-z0-9_-]+)/.exec(message.text);
    if (!match) throw new Error('No token link in email');
    return match[1];
  }

  it('creates an invitation, emails a link through the real queue, and never returns the token', async () => {
    const res = await invite({ email: '  New.Agent@Example.COM ', role: 'agent' }).expect(201);

    expect(res.body).toMatchObject({ email: 'new.agent@example.com', role: 'agent', status: 'pending', sendCount: 1 });
    expect(res.body.invitedByEmail).toBe('owner@northwind.com');

    const [message] = await waitForEmails('new.agent@example.com');
    const token = tokenFrom(message);
    expect(token).toHaveLength(43); // 32 bytes, base64url
    expect(message.text).toContain('http://localhost:3000/invite#token=');

    // The response carries no trace of the token, and the database holds only its hash.
    expect(JSON.stringify(res.body)).not.toContain(token);
    const [row] = await dataSource.query('SELECT token_hash FROM invitations WHERE id = $1', [res.body.id]);
    expect(row.token_hash).toBe(hashToken(token));
    expect(row.token_hash).not.toContain(token);
  });

  it('expires in 7 days, measured by the database clock', async () => {
    await invite({ email: 'a@example.com', role: 'viewer' }).expect(201);
    const [row] = await dataSource.query(
      `SELECT abs(extract(epoch FROM (expires_at - (now() + interval '7 days')))) AS drift FROM invitations`,
    );
    expect(Number(row.drift)).toBeLessThan(60);
  });

  it('refuses a second pending invitation for the same address, whatever its capitalisation', async () => {
    await invite({ email: 'dup@example.com', role: 'viewer' }).expect(201);
    await invite({ email: 'DUP@Example.com', role: 'agent' }).expect(409);
  });

  // The partial unique index is the only thing that makes this hold: there is no pre-check for
  // a pending duplicate, so every one of these requests reaches the INSERT.
  it('lets exactly one of several concurrent invitations to one address succeed', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => invite({ email: 'race@example.com', role: 'viewer' })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM invitations WHERE email = 'race@example.com'`);
    expect(n).toBe(1);
  });

  it('allows re-inviting an address once its earlier invitation is no longer pending', async () => {
    const first = await invite({ email: 'again@example.com', role: 'viewer' }).expect(201);
    await request(app.getHttpServer())
      .delete(`/workspaces/1/invitations/${first.body.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    await invite({ email: 'again@example.com', role: 'viewer' }).expect(201);
  });

  it('refuses to invite someone who is already a member', async () => {
    await addMember('member@example.com', MembershipRole.VIEWER);
    await invite({ email: 'Member@Example.com', role: 'agent' }).expect(409);
  });

  it('forbids agents and viewers from inviting (members.invite is owner-only)', async () => {
    const agent = await addMember('agent@northwind.com', MembershipRole.AGENT);
    const viewer = await addMember('viewer@northwind.com', MembershipRole.VIEWER);
    await invite({ email: 'x@example.com', role: 'viewer' }, agent).expect(403);
    await invite({ email: 'x@example.com', role: 'viewer' }, viewer).expect(403);
  });

  // Grants agents members.invite for the duration of the test, the way a policy change would —
  // which is the only situation in which the ceiling can bind.
  it('enforces the role ceiling: an agent allowed to invite still cannot invite an owner', async () => {
    const agent = await addMember('agent@northwind.com', MembershipRole.AGENT);
    try {
      await dataSource.query(`INSERT INTO role_permissions (role, permission_key) VALUES ('agent', 'members.invite')`);
      await permissions.reload();

      await invite({ email: 'viewer-to-be@example.com', role: 'viewer' }, agent).expect(201);
      await invite({ email: 'agent-to-be@example.com', role: 'agent' }, agent).expect(201);
      const res = await invite({ email: 'owner-to-be@example.com', role: 'owner' }, agent).expect(403);
      expect(res.body.message).toMatch(/above your own/);
    } finally {
      await dataSource.query(`DELETE FROM role_permissions WHERE role = 'agent' AND permission_key = 'members.invite'`);
      await permissions.reload();
    }
  });

  it('rotates the token on resend, so the previous link stops working', async () => {
    const created = await invite({ email: 'resend@example.com', role: 'viewer' }).expect(201);
    const [first] = await waitForEmails('resend@example.com');

    const res = await request(app.getHttpServer())
      .post(`/workspaces/1/invitations/${created.body.id}/resend`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);
    expect(res.body.sendCount).toBe(2);

    const [, second] = await waitForEmails('resend@example.com', 2);
    expect(tokenFrom(second)).not.toBe(tokenFrom(first));

    const [row] = await dataSource.query('SELECT token_hash FROM invitations WHERE id = $1', [created.body.id]);
    expect(row.token_hash).toBe(hashToken(tokenFrom(second)));
    expect(row.token_hash).not.toBe(hashToken(tokenFrom(first)));
  });

  it('caps resends of one invitation at 3 per hour', async () => {
    const created = await invite({ email: 'spam@example.com', role: 'viewer' }).expect(201);
    const resend = () =>
      request(app.getHttpServer())
        .post(`/workspaces/1/invitations/${created.body.id}/resend`)
        .set('Authorization', `Bearer ${ownerToken}`);

    for (let i = 0; i < 3; i++) await resend().expect(201);
    await resend().expect(429);
  });

  it('revokes a pending invitation, and refuses to resend or revoke it again', async () => {
    const created = await invite({ email: 'revoke@example.com', role: 'viewer' }).expect(201);
    const revoke = () =>
      request(app.getHttpServer())
        .delete(`/workspaces/1/invitations/${created.body.id}`)
        .set('Authorization', `Bearer ${ownerToken}`);

    const res = await revoke().expect(200);
    expect(res.body.status).toBe('revoked');
    await revoke().expect(409);
    await request(app.getHttpServer())
      .post(`/workspaces/1/invitations/${created.body.id}/resend`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(409);
  });

  it('answers 404, not 403, for another workspace\'s invitation', async () => {
    const created = await invite({ email: 'mine@example.com', role: 'viewer' }).expect(201);
    const other = await register('other@acme.com', 'Acme');

    await request(app.getHttpServer())
      .delete(`/workspaces/2/invitations/${created.body.id}`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .expect(404);
    const [row] = await dataSource.query('SELECT status FROM invitations WHERE id = $1', [created.body.id]);
    expect(row.status).toBe('pending');
  });

  it('derives "expired" from expires_at, and filters and paginates on it server-side', async () => {
    for (const email of ['p1@example.com', 'p2@example.com', 'p3@example.com']) {
      await invite({ email, role: 'viewer' }).expect(201);
    }
    await dataSource.query(`UPDATE invitations SET expires_at = now() - interval '1 second' WHERE email = 'p1@example.com'`);

    const list = (query: string) =>
      request(app.getHttpServer())
        .get(`/workspaces/1/invitations${query}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

    const expired = await list('?status=expired');
    expect(expired.body.items.map((i: { email: string }) => i.email)).toEqual(['p1@example.com']);
    // Still 'pending' in storage — expiry is never written, only derived.
    const [stored] = await dataSource.query(`SELECT status FROM invitations WHERE email = 'p1@example.com'`);
    expect(stored.status).toBe('pending');

    // Server-side search, combined with the status filter.
    const searched = await list('?status=pending&search=P3');
    expect(searched.body.items.map((i: { email: string }) => i.email)).toEqual(['p3@example.com']);

    const pending = await list('?status=pending&pageSize=1&page=2');
    expect(pending.body).toMatchObject({ total: 2, page: 2, pageSize: 1, totalPages: 2 });
    expect(pending.body.items).toHaveLength(1);
    expect(pending.body.items[0].email).toBe('p2@example.com'); // newest first: p3, then p2
  });

  it('escapes user-controlled text in the HTML email', async () => {
    await dataSource.query(`UPDATE workspaces SET name = '<a href="https://evil.example">Verify your account</a>' WHERE id = 1`);
    await invite({ email: 'target@example.com', role: 'viewer' }).expect(201);

    const [message] = await waitForEmails('target@example.com');
    expect(message.html).not.toContain('<a href="https://evil.example">');
    expect(message.html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;');
  });

  describe('accepting', () => {
    async function inviteAndGetToken(email: string, role = 'agent'): Promise<{ id: number; token: string }> {
      const res = await invite({ email, role }).expect(201);
      const messages = await waitForEmails(res.body.email, res.body.sendCount);
      return { id: res.body.id, token: tokenFrom(messages[messages.length - 1]) };
    }

    const post = (path: string, body: object, bearer?: string) => {
      const req = request(app.getHttpServer()).post(`/invitations/${path}`);
      if (bearer) req.set('Authorization', `Bearer ${bearer}`);
      return req.send(body);
    };

    async function membershipCount(email: string): Promise<number> {
      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM memberships
         WHERE workspace_id = 1 AND user_id = (SELECT id FROM users WHERE email = $1)`,
        [email],
      );
      return n;
    }

    it('previews an invitation without consuming it', async () => {
      const { token } = await inviteAndGetToken('preview@example.com');

      const res = await post('preview', { token }).expect(200);
      expect(res.body).toMatchObject({
        workspaceName: 'Northwind',
        email: 'preview@example.com',
        role: 'agent',
        invitedByEmail: 'owner@northwind.com',
        status: 'pending',
        accountExists: false,
      });
      await post('preview', { token }).expect(200); // still usable
    });

    it('answers 404 for a token that does not exist', async () => {
      await post('preview', { token: 'A'.repeat(43) }).expect(404);
    });

    it('signs up a new user with the INVITED address, joins them to the workspace, and signs them in', async () => {
      const { token } = await inviteAndGetToken('New.Hire@Example.com');

      const res = await post('accept-signup', { token, password: 'a-good-password' }).expect(201);
      expect(res.body).toMatchObject({ workspaceId: 1, role: 'agent', alreadyMember: false });

      const me = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
      expect(me.body.email).toBe('new.hire@example.com');
      expect(me.body.memberships).toEqual([expect.objectContaining({ workspaceId: 1, role: 'agent' })]);

      // A real account: the password works for a normal login afterwards.
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'new.hire@example.com', password: 'a-good-password' })
        .expect(200);

      const [row] = await dataSource.query(`SELECT status, accepted_by_user_id FROM invitations WHERE id = 1`);
      expect(row).toEqual({ status: 'accepted', accepted_by_user_id: me.body.userId });
    });

    it('is single-use: the same link cannot be accepted twice', async () => {
      const { token } = await inviteAndGetToken('once@example.com');
      await post('accept-signup', { token, password: 'a-good-password' }).expect(201);

      const again = await post('accept-signup', { token, password: 'another-password' }).expect(409);
      expect(again.body.message).toMatch(/already been accepted/);
      expect((await post('preview', { token }).expect(200)).body.status).toBe('accepted');
    });

    it('tells an existing account holder to sign in instead of creating a second account', async () => {
      await register('existing@example.com', 'Their Own Workspace');
      const { token } = await inviteAndGetToken('existing@example.com');

      expect((await post('preview', { token }).expect(200)).body.accountExists).toBe(true);
      await post('accept-signup', { token, password: 'a-good-password' }).expect(409);
    });

    it('lets a signed-in user with the invited address accept, adding a second workspace', async () => {
      const { accessToken } = await register('existing@example.com', 'Their Own Workspace');
      const { token } = await inviteAndGetToken('existing@example.com', 'viewer');

      const res = await post('accept', { token }, accessToken).expect(200);
      expect(res.body).toEqual({ workspaceId: 1, role: 'viewer', alreadyMember: false });

      const me = await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${accessToken}`);
      expect(me.body.memberships.map((m: { workspaceId: number }) => m.workspaceId).sort()).toEqual([1, 2]);
    });

    // The forwarded-link case: the token is valid, but it was sent to someone else.
    it('refuses a valid link accepted by a different account, and leaves it usable for the real invitee', async () => {
      const { token } = await inviteAndGetToken('intended@example.com');
      const { accessToken: intruder } = await register('colleague@example.com', 'Colleague Co');

      const res = await post('accept', { token }, intruder).expect(403);
      expect(res.body.message).toContain('intended@example.com');
      expect(await membershipCount('colleague@example.com')).toBe(0);
      expect((await post('preview', { token }).expect(200)).body.status).toBe('pending');
    });

    it('requires a signed-in user for /accept', async () => {
      const { token } = await inviteAndGetToken('anon@example.com');
      await post('accept', { token }).expect(401);
    });

    it('answers 410 Gone for an expired invitation, and creates no account', async () => {
      const { token } = await inviteAndGetToken('late@example.com');
      await dataSource.query(`UPDATE invitations SET expires_at = now() - interval '1 second'`);

      const res = await post('accept-signup', { token, password: 'a-good-password' }).expect(410);
      expect(res.body.message).toMatch(/expired/);
      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM users WHERE email = 'late@example.com'`);
      expect(n).toBe(0);
    });

    it('answers 410 Gone for a revoked invitation', async () => {
      const { id, token } = await inviteAndGetToken('revoked@example.com');
      await request(app.getHttpServer())
        .delete(`/workspaces/1/invitations/${id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      await post('accept-signup', { token, password: 'a-good-password' }).expect(410);
    });

    it('kills the old link on resend: it answers 404, and the new one works', async () => {
      const { id, token: oldToken } = await inviteAndGetToken('resent@example.com');
      await request(app.getHttpServer())
        .post(`/workspaces/1/invitations/${id}/resend`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(201);
      const [, second] = await waitForEmails('resent@example.com', 2);

      await post('accept-signup', { token: oldToken, password: 'a-good-password' }).expect(404);
      await post('accept-signup', { token: tokenFrom(second), password: 'a-good-password' }).expect(201);
    });

    // Double-accept race: the invitee double-clicks, or two tabs submit at once. Both requests
    // pass every pre-check; only the conditional UPDATE decides.
    it('lets exactly one of two concurrent accepts by the same user succeed', async () => {
      const { accessToken } = await register('double@example.com', 'Double Co');
      const { token } = await inviteAndGetToken('double@example.com');

      const results = await Promise.all([post('accept', { token }, accessToken), post('accept', { token }, accessToken)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await membershipCount('double@example.com')).toBe(1);
    });

    it('lets exactly one of two concurrent sign-ups on one link succeed, leaving one account', async () => {
      const { token } = await inviteAndGetToken('signup-race@example.com');

      const results = await Promise.all([
        post('accept-signup', { token, password: 'password-one' }),
        post('accept-signup', { token, password: 'password-two' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM users WHERE email = 'signup-race@example.com'`);
      expect(n).toBe(1);
    });

    it('rejects a malformed token before touching the database', async () => {
      await post('preview', { token: "'; DROP TABLE invitations; --" }).expect(400);
    });
  });

  describe('email delivery tracking', () => {
    const getOne = (id: number) =>
      request(app.getHttpServer()).get(`/workspaces/1/invitations/${id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);

    async function waitForEmailStatus(id: number, status: string) {
      for (let i = 0; i < 100; i++) {
        const res = await getOne(id);
        if (res.body.emailStatus === status) return res.body;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`Invitation ${id} never reached emailStatus=${status}`);
    }

    it('starts queued and becomes sent once the worker has handed the email to the sender', async () => {
      const created = await invite({ email: 'tracked@example.com', role: 'viewer' }).expect(201);
      expect(created.body.emailStatus).toBe('queued');
      expect(created.body.emailSentAt).toBeNull();

      const sent = await waitForEmailStatus(created.body.id, 'sent');
      expect(sent.emailSentAt).not.toBeNull();
    });

    it('resets to queued on resend', async () => {
      const created = await invite({ email: 'tracked@example.com', role: 'viewer' }).expect(201);
      await waitForEmailStatus(created.body.id, 'sent');

      const resent = await request(app.getHttpServer())
        .post(`/workspaces/1/invitations/${created.body.id}/resend`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(201);
      expect(resent.body).toMatchObject({ emailStatus: 'queued', emailSentAt: null });
      await waitForEmailStatus(created.body.id, 'sent');
    });

    // A late report about a superseded email (the one sent before a resend rotated the token)
    // must not touch the current email's status.
    it('ignores a delivery report for a token that has since been rotated', async () => {
      const created = await invite({ email: 'stale@example.com', role: 'viewer' }).expect(201);
      await waitForEmailStatus(created.body.id, 'sent');
      await dataSource.query(`UPDATE invitations SET email_status = 'queued', email_sent_at = NULL WHERE id = $1`, [
        created.body.id,
      ]);

      const events = app.get(EmailDeliveryEvents);
      await events.report({ type: 'invitation', ref: { id: created.body.id, tokenHash: 'not-the-current-hash' } }, { status: 'sent' });
      expect((await getOne(created.body.id)).body.emailStatus).toBe('queued');
    });

    it('never throws out of report(), even when recording fails — so a send is never retried for it', async () => {
      const events = app.get(EmailDeliveryEvents);
      events.register('explodes', async () => {
        throw new Error('database unavailable');
      });
      await expect(events.report({ type: 'explodes', ref: { id: 1 } }, { status: 'sent' })).resolves.toBeUndefined();
    });

    it('404s a single invitation from another workspace', async () => {
      const created = await invite({ email: 'mine@example.com', role: 'viewer' }).expect(201);
      const other = await register('other@acme.com', 'Acme');
      await request(app.getHttpServer())
        .get(`/workspaces/2/invitations/${created.body.id}`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .expect(404);
    });
  });
});
