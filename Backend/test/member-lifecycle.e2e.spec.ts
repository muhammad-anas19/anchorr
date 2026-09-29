import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { User } from '../src/database/entities/user.entity';
import { Membership } from '../src/database/entities/membership.entity';
import { MembershipRole } from '../src/database/entities/membership-role.enum';
import { AgentPresenceService } from '../src/realtime/agent-presence.service';
import { WorkspacesService } from '../src/modules/workspaces/workspaces.service';
import { lockMembershipForShare } from '../src/modules/tenancy/membership-locks';
import { resetDatabase } from './helpers/reset-database';

describe('Member lifecycle: remove, leave, transfer (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let presence: AgentPresenceService;
  let baseUrl: string;
  const clients: ClientSocket[] = [];
  let ownerToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    dataSource = moduleRef.get(DataSource);
    jwtService = moduleRef.get(JwtService);
    presence = moduleRef.get(AgentPresenceService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'owner@northwind.com', password: 'correct-horse-battery', workspaceName: 'Northwind' })
      .expect(201);
    ownerToken = res.body.accessToken;
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect();
  });

  async function addMember(email: string, role: MembershipRole): Promise<{ userId: number; token: string }> {
    const user = await dataSource.getRepository(User).save({ email, passwordHash: 'unused' });
    await dataSource.getRepository(Membership).save({ workspaceId: 1, userId: user.id, role });
    return { userId: user.id, token: await jwtService.signAsync({ sub: user.id }) };
  }

  const api = (method: 'get' | 'post' | 'patch' | 'delete', path: string, token: string, body?: object) => {
    const req = request(app.getHttpServer())[method](`/workspaces/1${path}`).set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };

  async function seedSession(sessionId: string, status: string, claimedBy: number | null): Promise<void> {
    await dataSource.query(
      `INSERT INTO conversation_sessions (workspace_id, session_id, status, claimed_by_user_id, claimed_at, escalated_at)
       VALUES (1, $1, $2, $3, CASE WHEN $3::int IS NULL THEN NULL ELSE now() END, now() - interval '10 minutes')`,
      [sessionId, status, claimedBy],
    );
  }

  async function sessionRow(sessionId: string) {
    const [row] = await dataSource.query(
      `SELECT status, claimed_by_user_id AS "claimedBy", extract(epoch FROM now() - escalated_at)::int AS "waitedSeconds"
       FROM conversation_sessions WHERE session_id = $1`,
      [sessionId],
    );
    return row;
  }

  function connectAgent(token: string): ClientSocket {
    const client = io(`${baseUrl}/widget`, {
      auth: { token, workspaceId: 1 },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    clients.push(client);
    return client;
  }

  function waitFor<T = unknown>(client: ClientSocket, event: string, timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
      client.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  describe('removing a member', () => {
    // REST authorization is re-checked on every request against the memberships table — the JWT
    // carries only the user id, no workspace or role. So the SAME, still-valid token stops
    // working for this workspace the instant the membership row is gone. Nothing to revoke.
    it('ends their REST access immediately, with the same unexpired token', async () => {
      const agent = await addMember('agent@northwind.com', MembershipRole.AGENT);
      await api('get', '/members', agent.token).expect(200);

      await api('delete', `/members/${agent.userId}`, ownerToken).expect(200);

      await api('get', '/members', agent.token).expect(403);
    });

    it('puts their claimed conversations back in the queue, keeping the original wait time', async () => {
      const agent = await addMember('agent@northwind.com', MembershipRole.AGENT);
      await seedSession('claimed-1', 'claimed', agent.userId);
      await seedSession('resolved-1', 'resolved', agent.userId);

      await api('delete', `/members/${agent.userId}`, ownerToken).expect(200);

      const released = await sessionRow('claimed-1');
      expect(released.status).toBe('escalated');
      expect(released.claimedBy).toBeNull();
      expect(released.waitedSeconds).toBeGreaterThanOrEqual(600); // clock not restarted

      // History is not access: who resolved it stays recorded.
      expect(await sessionRow('resolved-1')).toMatchObject({ status: 'resolved', claimedBy: agent.userId });
    });

    it('cuts off their live socket with a reason, and tells other agents the conversation is back', async () => {
      const removed = await addMember('removed@northwind.com', MembershipRole.AGENT);
      const colleague = await addMember('colleague@northwind.com', MembershipRole.AGENT);
      await seedSession('claimed-live', 'claimed', removed.userId);

      const removedSocket = connectAgent(removed.token);
      const colleagueSocket = connectAgent(colleague.token);
      await Promise.all([waitFor(removedSocket, 'ready'), waitFor(colleagueSocket, 'ready')]);
      expect(presence.isOnline(1, removed.userId)).toBe(true);

      const revoked = waitFor<{ reason: string }>(removedSocket, 'access-revoked');
      const disconnected = waitFor<string>(removedSocket, 'disconnect');
      const requeued = waitFor<{ sessionId: string }>(colleagueSocket, 'session-escalated');

      await api('delete', `/members/${removed.userId}`, ownerToken).expect(200);

      expect(await revoked).toEqual({ workspaceId: 1, reason: 'removed' });
      // 'io server disconnect' is the server-initiated reason — the one socket.io-client does not
      // auto-reconnect from. A network drop would be 'transport close' and would reconnect.
      expect(await disconnected).toBe('io server disconnect');
      expect(await requeued).toEqual({ sessionId: 'claimed-live' });
      expect(presence.isOnline(1, removed.userId)).toBe(false);
      expect(colleagueSocket.connected).toBe(true);
    });

    // Sequentially, the last owner is unreachable by removal: removing needs an owner, and the
    // only owner left is the target, whose self-removal is routed to leave() (which refuses —
    // see "leaving"). The owner check inside removal matters under CONCURRENCY — two owners
    // removing each other at once — the write-skew case the workspace lock exists for.
    it('lets an owner remove another owner, leaving the last one reachable only via leave()', async () => {
      const second = await addMember('second-owner@northwind.com', MembershipRole.OWNER);
      await api('delete', `/members/${second.userId}`, ownerToken).expect(200);
      await api('delete', '/members/1', ownerToken).expect(400);
      await api('post', '/leave', ownerToken).expect(409);
    });

    it('sends you to leave() instead of removing yourself', async () => {
      const res = await api('delete', '/members/1', ownerToken).expect(400);
      expect(res.body.message).toMatch(/leave/);
    });

    it('answers 404 for someone who is not a member', async () => {
      await api('delete', '/members/999', ownerToken).expect(404);
    });

    it('is owner-only', async () => {
      const agent = await addMember('agent@northwind.com', MembershipRole.AGENT);
      const viewer = await addMember('viewer@northwind.com', MembershipRole.VIEWER);
      await api('delete', `/members/${viewer.userId}`, agent.token).expect(403);
    });
  });

  describe('leaving', () => {
    it('lets any member leave, including a viewer', async () => {
      const viewer = await addMember('viewer@northwind.com', MembershipRole.VIEWER);
      await api('post', '/leave', viewer.token).expect(200);
      await api('get', '/members', viewer.token).expect(403);
    });

    it('refuses to let the last owner leave, and lets them once another owner exists', async () => {
      const res = await api('post', '/leave', ownerToken).expect(409);
      expect(res.body.message).toMatch(/at least one owner/);

      await addMember('second-owner@northwind.com', MembershipRole.OWNER);
      await api('post', '/leave', ownerToken).expect(200);
    });
  });

  describe('demotion that removes handoff.work', () => {
    it('releases claimed conversations and cuts the socket when an agent becomes a viewer', async () => {
      const agent = await addMember('agent@northwind.com', MembershipRole.AGENT);
      await seedSession('claimed-demoted', 'claimed', agent.userId);
      const socket = connectAgent(agent.token);
      await waitFor(socket, 'ready');
      const revoked = waitFor<{ reason: string }>(socket, 'access-revoked');

      await api('patch', `/members/${agent.userId}`, ownerToken, { role: 'viewer' }).expect(200);

      expect((await revoked).reason).toBe('role-changed');
      expect((await sessionRow('claimed-demoted')).status).toBe('escalated');
      // Still a member — a viewer can still read the member list.
      await api('get', '/members', agent.token).expect(200);
    });

    it('leaves the socket alone when the new role still has handoff.work', async () => {
      const second = await addMember('second-owner@northwind.com', MembershipRole.OWNER);
      await seedSession('claimed-kept', 'claimed', second.userId);
      const socket = connectAgent(second.token);
      await waitFor(socket, 'ready');

      await api('patch', `/members/${second.userId}`, ownerToken, { role: 'agent' }).expect(200);

      await new Promise((r) => setTimeout(r, 300));
      expect(socket.connected).toBe(true);
      expect((await sessionRow('claimed-kept')).status).toBe('claimed');
    });
  });

  describe('transferring ownership', () => {
    it('promotes the target and steps the current owner down to agent, atomically', async () => {
      const agent = await addMember('agent@northwind.com', MembershipRole.AGENT);

      const res = await api('post', '/transfer-ownership', ownerToken, { userId: agent.userId }).expect(200);
      expect(res.body).toEqual({ newOwnerUserId: agent.userId, previousOwnerUserId: 1, previousOwnerRole: 'agent' });

      const roles = await dataSource.query(`SELECT user_id AS "userId", role FROM memberships WHERE workspace_id = 1 ORDER BY user_id`);
      expect(roles).toEqual([
        { userId: 1, role: 'agent' },
        { userId: agent.userId, role: 'owner' },
      ]);
      // The previous owner lost owner-only permissions on their very next request.
      await api('post', '/transfer-ownership', ownerToken, { userId: agent.userId }).expect(403);
    });

    it('refuses a non-member target and yourself, and is owner-only', async () => {
      const agent = await addMember('agent@northwind.com', MembershipRole.AGENT);
      await api('post', '/transfer-ownership', ownerToken, { userId: 999 }).expect(404);
      await api('post', '/transfer-ownership', ownerToken, { userId: 1 }).expect(400);
      await api('post', '/transfer-ownership', agent.token, { userId: agent.userId }).expect(403);
    });
  });

  // The claim-vs-removal race, made deterministic the same way as the last-owner test in
  // workspaces.e2e: one side is played by hand and paused at the dangerous moment.
  //
  // Side A is HandoffService.claim, mid-flight: it has share-locked the agent's membership (the
  // real helper) and marked the session claimed, but not committed. Side B is the real removal.
  // Without the share lock, B would delete the membership, find nothing claimed yet (A hasn't
  // committed), commit — and then A commits a claim by someone who is no longer a member.
  it('makes a removal wait for an in-flight claim, then release what it claimed', async () => {
    const agent = await addMember('agent@northwind.com', MembershipRole.AGENT);
    await seedSession('racing', 'escalated', null);
    const workspaces = app.get(WorkspacesService);

    const sideA = dataSource.createQueryRunner();
    await sideA.connect();
    await sideA.startTransaction();
    let removal: Promise<unknown> | undefined;
    try {
      await lockMembershipForShare(sideA.manager, 1, agent.userId);
      await sideA.query(
        `UPDATE conversation_sessions SET status = 'claimed', claimed_by_user_id = $1, claimed_at = now()
         WHERE session_id = 'racing' AND status = 'escalated'`,
        [agent.userId],
      );

      removal = workspaces.removeMember(1, 1, agent.userId);
      expect(await waitUntilBlocked(removal)).toBe(true);

      await sideA.commitTransaction();
    } finally {
      if (sideA.isTransactionActive) await sideA.rollbackTransaction();
      await sideA.release();
    }

    await removal;
    expect(await sessionRow('racing')).toMatchObject({ status: 'escalated', claimedBy: null });
  });

  async function waitUntilBlocked(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let i = 0; i < 100 && !settled; i++) {
      const [row] = await dataSource.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (row.n > 0) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  // HandoffService.claim now runs in a transaction with the membership share-lock. These cover
  // it without Gemini (handoff.e2e's fixtures embed real documents), so the change is verified
  // even when the daily embedding quota is spent.
  describe('claim, now membership-locked', () => {
    const claim = (sessionId: string, token: string) => api('patch', `/handoff/${sessionId}/claim`, token);

    it('still claims an escalated session for a member', async () => {
      const agent = await addMember('agent@northwind.com', MembershipRole.AGENT);
      await seedSession('to-claim', 'escalated', null);
      await claim('to-claim', agent.token).expect(200);
      expect(await sessionRow('to-claim')).toMatchObject({ status: 'claimed', claimedBy: agent.userId });
    });

    it('still lets exactly one of two concurrent claims win', async () => {
      const a = await addMember('a@northwind.com', MembershipRole.AGENT);
      const b = await addMember('b@northwind.com', MembershipRole.AGENT);
      await seedSession('contested', 'escalated', null);

      const results = await Promise.all([claim('contested', a.token), claim('contested', b.token)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('refuses a claim from someone removed a moment ago', async () => {
      const agent = await addMember('agent@northwind.com', MembershipRole.AGENT);
      await seedSession('after-removal', 'escalated', null);
      await api('delete', `/members/${agent.userId}`, ownerToken).expect(200);

      await claim('after-removal', agent.token).expect(403);
      expect((await sessionRow('after-removal')).status).toBe('escalated');
    });
  });
});
