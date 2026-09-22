import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { User } from '../src/database/entities/user.entity';
import { Membership } from '../src/database/entities/membership.entity';
import { MembershipRole } from '../src/database/entities/membership-role.enum';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../src/embedding/embedding-provider.interface';
import { ANSWER_GENERATION_PROVIDER } from '../src/generation/answer-generation-provider.interface';

describe('Agent handoff (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let embeddingProvider: EmbeddingProvider;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ANSWER_GENERATION_PROVIDER)
      .useValue({
        generate: async () => {
          throw new Error('Simulated Gemini outage — forces a real escalation.');
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    jwtService = moduleRef.get(JwtService);
    embeddingProvider = moduleRef.get(EMBEDDING_PROVIDER);
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
    const res = await request(app.getHttpServer()).post('/auth/register').send({
      email,
      password: 'correct-horse-battery',
      workspaceName,
    });
    const [{ workspace_id: workspaceId }] = await dataSource.query(
      `SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
      [email],
    );
    return { token: res.body.accessToken as string, workspaceId: Number(workspaceId) };
  }

  async function addAgent(workspaceId: number, email: string): Promise<{ token: string; userId: number }> {
    const user = await dataSource.getRepository(User).save({ email, passwordHash: 'unused-in-this-test' });
    await dataSource.getRepository(Membership).save({ workspaceId, userId: user.id, role: MembershipRole.AGENT });
    const token = await jwtService.signAsync({ sub: user.id });
    return { token, userId: user.id };
  }

  async function seedEmbeddedChunk(workspaceId: number, content: string): Promise<void> {
    const doc = await dataSource.query(
      `INSERT INTO documents (workspace_id, original_filename, storage_key, mime_type, file_size_bytes, content_hash, status)
       VALUES ($1, 'refunds.pdf', $2, 'application/pdf', 10, $3, 'processing') RETURNING id`,
      [workspaceId, `key-${workspaceId}`, 'a'.repeat(64)],
    );
    const embedding = await embeddingProvider.embed(content);
    await dataSource.query(
      `INSERT INTO document_chunks (document_id, chunk_index, content, char_start, char_end, embedding)
       VALUES ($1, 0, $2, 0, $3, $4::vector)`,
      [doc[0].id, content, content.length, `[${embedding.join(',')}]`],
    );
  }

  async function triggerEscalation(token: string, workspaceId: number, sessionId: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`/workspaces/${workspaceId}/ask`)
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'How many days for a refund?', sessionId })
      .expect(201);
  }

  it(
    'a real generation failure creates an escalated ConversationSession, visible via the handoff list',
    async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');
      await triggerEscalation(token, workspaceId, 'session-1');

      const res = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ sessionId: 'session-1', status: 'escalated', claimedByUserId: null });
    },
    15000,
  );

  it(
    'a second, later escalation on the same session does not create a duplicate row',
    async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');
      await triggerEscalation(token, workspaceId, 'session-1');
      await triggerEscalation(token, workspaceId, 'session-1');

      const res = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toHaveLength(1);
    },
    20000,
  );

  it(
    'the detail endpoint returns the session plus its full turn history',
    async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');
      await triggerEscalation(token, workspaceId, 'session-1');

      const res = await request(app.getHttpServer())
        .get(`/workspaces/${workspaceId}/handoff/session-1`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.session).toMatchObject({ sessionId: 'session-1', status: 'escalated' });
      expect(res.body.turns).toHaveLength(1);
      expect(res.body.turns[0].question).toBe('How many days for a refund?');
    },
    15000,
  );

  it(
    'claiming an escalated session records who claimed it and moves it out of the active list ordering correctly',
    async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      const agent = await addAgent(workspaceId, 'agent@northwind.com');
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');
      await triggerEscalation(token, workspaceId, 'session-1');

      const res = await request(app.getHttpServer())
        .patch(`/workspaces/${workspaceId}/handoff/session-1/claim`)
        .set('Authorization', `Bearer ${agent.token}`)
        .expect(200);

      expect(res.body).toMatchObject({ status: 'claimed', claimedByUserId: agent.userId });
      expect(res.body.claimedAt).not.toBeNull();
    },
    15000,
  );

  it(
    'claiming an already-claimed session returns 409, not a silent overwrite',
    async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      const agentA = await addAgent(workspaceId, 'agent-a@northwind.com');
      const agentB = await addAgent(workspaceId, 'agent-b@northwind.com');
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');
      await triggerEscalation(token, workspaceId, 'session-1');

      await request(app.getHttpServer())
        .patch(`/workspaces/${workspaceId}/handoff/session-1/claim`)
        .set('Authorization', `Bearer ${agentA.token}`)
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/workspaces/${workspaceId}/handoff/session-1/claim`)
        .set('Authorization', `Bearer ${agentB.token}`)
        .expect(409);

      const [row] = await dataSource.query(
        'SELECT claimed_by_user_id FROM conversation_sessions WHERE workspace_id = $1 AND session_id = $2',
        [workspaceId, 'session-1'],
      );
      expect(row.claimed_by_user_id).toBe(agentA.userId);
    },
    15000,
  );

  it('claiming a session that does not exist returns 404', async () => {
    const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');

    await request(app.getHttpServer())
      .patch(`/workspaces/${workspaceId}/handoff/no-such-session/claim`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it(
    'resolving a claimed session marks it resolved',
    async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      const agent = await addAgent(workspaceId, 'agent@northwind.com');
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');
      await triggerEscalation(token, workspaceId, 'session-1');
      await request(app.getHttpServer())
        .patch(`/workspaces/${workspaceId}/handoff/session-1/claim`)
        .set('Authorization', `Bearer ${agent.token}`)
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch(`/workspaces/${workspaceId}/handoff/session-1/resolve`)
        .set('Authorization', `Bearer ${agent.token}`)
        .expect(200);

      expect(res.body.status).toBe('resolved');
    },
    15000,
  );

  it(
    'resolving a session that was never claimed returns 409, not a silent no-op',
    async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      const agent = await addAgent(workspaceId, 'agent@northwind.com');
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');
      await triggerEscalation(token, workspaceId, 'session-1');
      // Deliberately never claimed — still 'escalated', not 'claimed'.

      await request(app.getHttpServer())
        .patch(`/workspaces/${workspaceId}/handoff/session-1/resolve`)
        .set('Authorization', `Bearer ${agent.token}`)
        .expect(409);
    },
    15000,
  );

  it('resolving a session that does not exist returns 404', async () => {
    const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');

    await request(app.getHttpServer())
      .patch(`/workspaces/${workspaceId}/handoff/no-such-session/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it(
    'two agents claiming the same escalated session at the same instant: exactly one wins, the other gets 409',
    async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      const agentA = await addAgent(workspaceId, 'agent-a@northwind.com');
      const agentB = await addAgent(workspaceId, 'agent-b@northwind.com');
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');
      await triggerEscalation(token, workspaceId, 'session-1');

      // A real race, not simulated: two independent HTTP requests fired without awaiting
      // between them, both hitting the same row's atomic conditional UPDATE (Q2/Q3/Q4) at
      // effectively the same instant.
      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .patch(`/workspaces/${workspaceId}/handoff/session-1/claim`)
          .set('Authorization', `Bearer ${agentA.token}`),
        request(app.getHttpServer())
          .patch(`/workspaces/${workspaceId}/handoff/session-1/claim`)
          .set('Authorization', `Bearer ${agentB.token}`),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const [row] = await dataSource.query(
        'SELECT claimed_by_user_id FROM conversation_sessions WHERE workspace_id = $1 AND session_id = $2',
        [workspaceId, 'session-1'],
      );
      expect([agentA.userId, agentB.userId]).toContain(row.claimed_by_user_id);
    },
    15000,
  );

  it('rejects a viewer from claiming (owner/agent only)', async () => {
    const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
    const viewer = await dataSource
      .getRepository(User)
      .save({ email: 'viewer@northwind.com', passwordHash: 'unused-in-this-test' });
    await dataSource
      .getRepository(Membership)
      .save({ workspaceId, userId: viewer.id, role: MembershipRole.VIEWER });
    const viewerToken = await jwtService.signAsync({ sub: viewer.id });
    await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');
    await triggerEscalation(token, workspaceId, 'session-1');

    await request(app.getHttpServer())
      .patch(`/workspaces/${workspaceId}/handoff/session-1/claim`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
  });

  it('rejects a member of a different workspace entirely', async () => {
    const northwind = await registerOwner('anas@northwind.com', 'Northwind Devices');
    const acme = await registerOwner('sam@acme.com', 'Acme Corp');
    await seedEmbeddedChunk(northwind.workspaceId, 'Refunds are available within 30 days of purchase.');
    await triggerEscalation(northwind.token, northwind.workspaceId, 'session-1');

    await request(app.getHttpServer())
      .get(`/workspaces/${northwind.workspaceId}/handoff`)
      .set('Authorization', `Bearer ${acme.token}`)
      .expect(403);
  });
});
