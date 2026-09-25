import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { User } from '../src/database/entities/user.entity';
import { Membership } from '../src/database/entities/membership.entity';
import { MembershipRole } from '../src/database/entities/membership-role.enum';
import { AgentPresenceService } from '../src/realtime/agent-presence.service';
import { HIGH_PRIORITY_WAIT_SECONDS } from '../src/modules/handoff/handoff-queue.interface';

// Sessions and turns are inserted directly rather than driven through a real /ask call.
// That is deliberate and not a shortcut: what is under test here is the queue's SQL —
// pagination, search, filtering, the derived priority and wait times — and the only way to
// test "a session that has been waiting six minutes" is to control escalated_at directly.
// The escalation path that produces these rows in production already has its own real,
// end-to-end coverage in handoff.e2e.spec.ts.
describe('Agent console queue (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let presence: AgentPresenceService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    jwtService = moduleRef.get(JwtService);
    presence = moduleRef.get(AgentPresenceService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE conversation_sessions, conversations, document_chunks, document_contents, documents, refresh_tokens, memberships, users, workspaces RESTART IDENTITY',
    );
  });

  async function registerOwner(email: string, workspaceName: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'correct-horse-battery', workspaceName });
    const [{ workspace_id: workspaceId, user_id: userId }] = await dataSource.query(
      `SELECT m.workspace_id, m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
      [email],
    );
    return { token: res.body.accessToken as string, workspaceId: Number(workspaceId), userId: Number(userId) };
  }

  async function addAgent(workspaceId: number, email: string): Promise<{ token: string; userId: number }> {
    const user = await dataSource.getRepository(User).save({ email, passwordHash: 'unused-in-this-test' });
    await dataSource.getRepository(Membership).save({ workspaceId, userId: user.id, role: MembershipRole.AGENT });
    return { token: await jwtService.signAsync({ sub: user.id }), userId: user.id };
  }

  // waitedSeconds is applied to escalated_at, so the derived priority and waitingSeconds are
  // exercised against real Postgres time arithmetic rather than a value we hand it.
  async function seedSession(opts: {
    workspaceId: number;
    sessionId: string;
    status: 'escalated' | 'claimed' | 'resolved' | 'open';
    waitedSeconds?: number;
    claimedByUserId?: number;
    resolvedAt?: 'today' | 'yesterday';
  }): Promise<void> {
    await dataSource.query(
      `INSERT INTO conversation_sessions
         (workspace_id, session_id, status, claimed_by_user_id, escalated_at, resolved_at)
       VALUES ($1, $2, $3, $4, now() - ($5 || ' seconds')::interval, $6)`,
      [
        opts.workspaceId,
        opts.sessionId,
        opts.status,
        opts.claimedByUserId ?? null,
        String(opts.waitedSeconds ?? 0),
        opts.resolvedAt === 'today' ? new Date() : opts.resolvedAt === 'yesterday' ? new Date(Date.now() - 86_400_000) : null,
      ],
    );
  }

  async function seedTurn(
    workspaceId: number,
    sessionId: string,
    question: string,
    status: 'answered' | 'refused' | 'escalated',
    minDistance: number | null = 0.3,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO conversations (workspace_id, session_id, question, answer, status, min_distance, citations)
       VALUES ($1, $2, $3, 'seeded answer', $4, $5, '[]'::jsonb)`,
      [workspaceId, sessionId, question, status, minDistance],
    );
  }

  describe('queue listing', () => {
    it('filters by tab, and "all" never includes a session the AI is still handling', async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      await seedSession({ workspaceId, sessionId: 's-waiting', status: 'escalated' });
      await seedSession({ workspaceId, sessionId: 's-active', status: 'claimed' });
      await seedSession({ workspaceId, sessionId: 's-resolved', status: 'resolved' });
      await seedSession({ workspaceId, sessionId: 's-open', status: 'open' });

      const waiting = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/queue?tab=waiting`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(waiting.body.items.map((r: { sessionId: string }) => r.sessionId)).toEqual(['s-waiting']);

      const all = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/queue?tab=all`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const ids = all.body.items.map((r: { sessionId: string }) => r.sessionId);
      expect(ids).toHaveLength(3);
      expect(ids).not.toContain('s-open');
    });

    it('searches the real question text of the latest turn, not just the session id', async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      await seedSession({ workspaceId, sessionId: 'aaa', status: 'escalated' });
      await seedTurn(workspaceId, 'aaa', 'My invoice shows a returned device', 'refused');
      await seedSession({ workspaceId, sessionId: 'bbb', status: 'escalated' });
      await seedTurn(workspaceId, 'bbb', 'How do I reset my password?', 'refused');

      const res = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/queue?search=invoice`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ sessionId: 'aaa', topic: 'My invoice shows a returned device' });
      expect(res.body.total).toBe(1);
    });

    it('treats a search containing SQL wildcards as literal text, not as query syntax', async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      await seedSession({ workspaceId, sessionId: 'aaa', status: 'escalated' });
      await seedTurn(workspaceId, 'aaa', 'Why was I charged 100% of the fee?', 'refused');
      await seedSession({ workspaceId, sessionId: 'bbb', status: 'escalated' });
      await seedTurn(workspaceId, 'bbb', 'Where is my order?', 'refused');

      // A bare "%" would match everything if the pattern were built by string concatenation.
      const res = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/queue?search=${encodeURIComponent('100%')}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].sessionId).toBe('aaa');
    });

    it('derives priority from real wait time and filters on it', async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      await seedSession({ workspaceId, sessionId: 'old', status: 'escalated', waitedSeconds: HIGH_PRIORITY_WAIT_SECONDS + 60 });
      await seedSession({ workspaceId, sessionId: 'new', status: 'escalated', waitedSeconds: 5 });

      const high = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/queue?priority=high`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(high.body.items).toHaveLength(1);
      expect(high.body.items[0]).toMatchObject({ sessionId: 'old', priority: 'high' });
      expect(high.body.items[0].waitingSeconds).toBeGreaterThanOrEqual(HIGH_PRIORITY_WAIT_SECONDS);

      const normal = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/queue?priority=normal`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(normal.body.items.map((r: { sessionId: string }) => r.sessionId)).toEqual(['new']);
    });

    it('paginates without repeating or dropping a row across pages', async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      for (let i = 0; i < 7; i++) {
        // Distinct wait times so the ordering is unambiguous and the assertion is meaningful.
        await seedSession({ workspaceId, sessionId: `s-${i}`, status: 'escalated', waitedSeconds: 100 - i });
      }

      const page1 = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/queue?page=1&pageSize=3`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const page2 = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/queue?page=2&pageSize=3`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const page3 = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/queue?page=3&pageSize=3`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(page1.body).toMatchObject({ total: 7, page: 1, pageSize: 3, totalPages: 3 });
      expect(page1.body.items).toHaveLength(3);
      expect(page3.body.items).toHaveLength(1);

      const seen = [...page1.body.items, ...page2.body.items, ...page3.body.items].map(
        (r: { sessionId: string }) => r.sessionId,
      );
      expect(new Set(seen).size).toBe(7);
      // Longest-waiting first is the whole point of a support queue's default order.
      expect(seen[0]).toBe('s-0');
    });

    it('rejects a pageSize above the cap instead of running an unbounded query', async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/queue?pageSize=100000`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('never leaks another workspace\'s queue', async () => {
      const a = await registerOwner('anas@northwind.com', 'Northwind Devices');
      const b = await registerOwner('other@rival.com', 'Rival Corp');
      await seedSession({ workspaceId: b.workspaceId, sessionId: 'rival-session', status: 'escalated' });

      const res = await request(app.getHttpServer())
        .get(`/workspaces/${a.workspaceId}/handoff/queue?tab=all`)
        .set('Authorization', `Bearer ${a.token}`)
        .expect(200);

      expect(res.body.items).toHaveLength(0);
      expect(res.body.total).toBe(0);
    });

    it('reports the reason derived from the last turn, not a stored column', async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      await seedSession({ workspaceId, sessionId: 'weak', status: 'escalated' });
      await seedTurn(workspaceId, 'weak', 'Something obscure', 'refused', 0.61);
      await seedSession({ workspaceId, sessionId: 'broken', status: 'escalated' });
      await seedTurn(workspaceId, 'broken', 'Anything', 'escalated', 0.2);

      const res = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/queue?tab=all`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const byId = Object.fromEntries(res.body.items.map((r: { sessionId: string }) => [r.sessionId, r]));
      expect(byId['weak'].reason).toBe('Low confidence');
      expect(byId['broken'].reason).toBe('Generation failure');
      expect(byId['weak'].lastTurnMinDistance).toBeCloseTo(0.61, 5);
    });
  });

  describe('stats', () => {
    it('counts each status, and counts only sessions resolved today', async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      await seedSession({ workspaceId, sessionId: 'w1', status: 'escalated', waitedSeconds: 240 });
      await seedSession({ workspaceId, sessionId: 'w2', status: 'escalated', waitedSeconds: 30 });
      await seedSession({ workspaceId, sessionId: 'a1', status: 'claimed' });
      await seedSession({ workspaceId, sessionId: 'r1', status: 'resolved', resolvedAt: 'today' });
      await seedSession({ workspaceId, sessionId: 'r2', status: 'resolved', resolvedAt: 'yesterday' });

      const res = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/stats`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toMatchObject({ waiting: 2, active: 1, resolved: 2, resolvedToday: 1 });
      // Longest wait must come from the oldest WAITING session, not from any other status.
      expect(res.body.longestWaitSeconds).toBeGreaterThanOrEqual(240);
      expect(res.body.longestWaitSeconds).toBeLessThan(300);
    });
  });

  describe('presence', () => {
    it('reports online only for an agent with a live connection, and counts their claimed sessions', async () => {
      const { token, workspaceId, userId: ownerId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      const agent = await addAgent(workspaceId, 'agent@northwind.com');
      await seedSession({ workspaceId, sessionId: 'c1', status: 'claimed', claimedByUserId: agent.userId });
      await seedSession({ workspaceId, sessionId: 'c2', status: 'claimed', claimedByUserId: agent.userId });

      // Stand in for the gateway's own handleConnection — the same service it writes to.
      presence.add(workspaceId, agent.userId);

      const res = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/presence`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const byEmail = Object.fromEntries(res.body.map((r: { email: string }) => [r.email, r]));
      expect(byEmail['agent@northwind.com']).toMatchObject({ online: true, activeCount: 2 });
      expect(byEmail['anas@northwind.com']).toMatchObject({ online: false, activeCount: 0 });

      presence.remove(workspaceId, agent.userId);
      const after = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/presence`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(after.body.find((r: { email: string }) => r.email === 'agent@northwind.com').online).toBe(false);
      expect(ownerId).toBeGreaterThan(0);
    });

    it('one agent with two open tabs stays online until the last one closes', async () => {
      const { workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      const agent = await addAgent(workspaceId, 'agent@northwind.com');

      presence.add(workspaceId, agent.userId);
      presence.add(workspaceId, agent.userId);
      presence.remove(workspaceId, agent.userId);
      expect(presence.isOnline(workspaceId, agent.userId)).toBe(true);

      presence.remove(workspaceId, agent.userId);
      expect(presence.isOnline(workspaceId, agent.userId)).toBe(false);
    });
  });

  describe('escalation reasons', () => {
    it('reports real percentages over the last 30 days and ignores older turns', async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      await seedTurn(workspaceId, 's', 'q1', 'refused');
      await seedTurn(workspaceId, 's', 'q2', 'refused');
      await seedTurn(workspaceId, 's', 'q3', 'refused');
      await seedTurn(workspaceId, 's', 'q4', 'escalated');
      await seedTurn(workspaceId, 's', 'q5', 'answered');
      await dataSource.query(
        `INSERT INTO conversations (workspace_id, session_id, question, answer, status, min_distance, citations, created_at)
         VALUES ($1, 's', 'ancient', 'a', 'refused', 0.9, '[]'::jsonb, now() - interval '60 days')`,
        [workspaceId],
      );

      const res = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/escalation-reasons`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toEqual([
        { label: 'Low retrieval confidence', count: 3, percent: 75 },
        { label: 'Generation failure', count: 1, percent: 25 },
      ]);
    });
  });

  describe('turn transcript (cursor pagination)', () => {
    it('walks backwards through a transcript without repeating a turn', async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      await seedSession({ workspaceId, sessionId: 's-1', status: 'claimed' });
      for (let i = 1; i <= 5; i++) {
        await seedTurn(workspaceId, 's-1', `question ${i}`, 'answered');
      }

      const newest = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/s-1/turns?limit=2`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Returned oldest-first within the page, so a transcript reads in order.
      expect(newest.body.items.map((t: { question: string }) => t.question)).toEqual(['question 4', 'question 5']);
      expect(newest.body.hasMore).toBe(true);

      const older = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/s-1/turns?limit=2&cursor=${newest.body.nextCursor}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(older.body.items.map((t: { question: string }) => t.question)).toEqual(['question 2', 'question 3']);

      const oldest = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/s-1/turns?limit=2&cursor=${older.body.nextCursor}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(oldest.body.items.map((t: { question: string }) => t.question)).toEqual(['question 1']);
      expect(oldest.body.hasMore).toBe(false);
      expect(oldest.body.nextCursor).toBeNull();
    });

    // The exact failure mode offset pagination has and keyset does not.
    it('a turn arriving mid-scroll does not shift the window and cause a repeat', async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      await seedSession({ workspaceId, sessionId: 's-1', status: 'claimed' });
      for (let i = 1; i <= 4; i++) {
        await seedTurn(workspaceId, 's-1', `question ${i}`, 'answered');
      }

      const firstPage = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/s-1/turns?limit=2`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // The customer says something else while the agent is scrolling back.
      await seedTurn(workspaceId, 's-1', 'question 5', 'answered');

      const secondPage = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/s-1/turns?limit=2&cursor=${firstPage.body.nextCursor}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const firstIds = firstPage.body.items.map((t: { id: number }) => t.id);
      const secondIds = secondPage.body.items.map((t: { id: number }) => t.id);
      expect(secondIds.some((id: number) => firstIds.includes(id))).toBe(false);
      expect(secondPage.body.items.map((t: { question: string }) => t.question)).toEqual(['question 1', 'question 2']);
    });
  });

  describe('playground config', () => {
    it('reports the real threshold, top-k and searchable chunk count', async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');

      const res = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/ask/config`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toMatchObject({
        searchMode: 'Vector',
        topK: 5,
        confidenceThreshold: 0.45,
        searchableChunks: 0,
      });
      expect(typeof res.body.model).toBe('string');
    });
  });
});
