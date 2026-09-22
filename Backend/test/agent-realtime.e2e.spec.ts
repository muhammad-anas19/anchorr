import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { User } from '../src/database/entities/user.entity';
import { Membership } from '../src/database/entities/membership.entity';
import { MembershipRole } from '../src/database/entities/membership-role.enum';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../src/embedding/embedding-provider.interface';
import { ANSWER_GENERATION_PROVIDER } from '../src/generation/answer-generation-provider.interface';

describe('Agent presence and real-time notifications (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let embeddingProvider: EmbeddingProvider;
  let baseUrl: string;
  const clients: ClientSocket[] = [];

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
    await app.listen(0);
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
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

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.disconnect();
    }
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

  async function addMember(
    workspaceId: number,
    email: string,
    role: MembershipRole,
  ): Promise<{ token: string; userId: number }> {
    const user = await dataSource.getRepository(User).save({ email, passwordHash: 'unused-in-this-test' });
    await dataSource.getRepository(Membership).save({ workspaceId, userId: user.id, role });
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

  function connectAgent(token: string, workspaceId: number): ClientSocket {
    const client = io(`${baseUrl}/widget`, {
      auth: { token, workspaceId },
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

  it('an owner or agent with a valid JWT can connect', async () => {
    const { workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
    const agent = await addMember(workspaceId, 'agent@northwind.com', MembershipRole.AGENT);

    const client = connectAgent(agent.token, workspaceId);
    await waitFor(client, 'ready');
    expect(client.connected).toBe(true);
  });

  it('rejects a viewer role — the console is owner/agent only', async () => {
    const { workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
    const viewer = await addMember(workspaceId, 'viewer@northwind.com', MembershipRole.VIEWER);

    const client = connectAgent(viewer.token, workspaceId);
    await waitFor(client, 'disconnect');
    expect(client.connected).toBe(false);
  });

  it('rejects a forged JWT (valid shape, wrong signature)', async () => {
    const { workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
    const forged = jwt.sign({ sub: 1 }, 'not-the-real-secret', { expiresIn: '15m' });

    const client = connectAgent(forged, workspaceId);
    await waitFor(client, 'disconnect');
    expect(client.connected).toBe(false);
  });

  it('rejects a real JWT for a user with no membership in that workspace', async () => {
    const northwind = await registerOwner('anas@northwind.com', 'Northwind Devices');
    const acme = await registerOwner('sam@acme.com', 'Acme Corp');

    // acme's own valid token, used against northwind's workspaceId.
    const client = connectAgent(acme.token, northwind.workspaceId);
    await waitFor(client, 'disconnect');
    expect(client.connected).toBe(false);
  });

  it(
    'a connected agent is notified in real time when a conversation escalates',
    async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      const agent = await addMember(workspaceId, 'agent@northwind.com', MembershipRole.AGENT);
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');

      const client = connectAgent(agent.token, workspaceId);
      await waitFor(client, 'ready');

      const notification = waitFor<{ sessionId: string }>(client, 'session-escalated');
      await triggerEscalation(token, workspaceId, 'session-1');

      expect((await notification).sessionId).toBe('session-1');
    },
    15000,
  );

  it(
    'every other connected agent is notified in real time when one agent claims a session',
    async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      const agentA = await addMember(workspaceId, 'agent-a@northwind.com', MembershipRole.AGENT);
      const agentB = await addMember(workspaceId, 'agent-b@northwind.com', MembershipRole.AGENT);
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');
      await triggerEscalation(token, workspaceId, 'session-1');

      const clientB = connectAgent(agentB.token, workspaceId);
      await waitFor(clientB, 'ready');
      const notification = waitFor<{ sessionId: string; claimedByUserId: number }>(clientB, 'session-claimed');

      await request(app.getHttpServer())
        .patch(`/workspaces/${workspaceId}/handoff/session-1/claim`)
        .set('Authorization', `Bearer ${agentA.token}`)
        .expect(200);

      const payload = await notification;
      expect(payload.sessionId).toBe('session-1');
      expect(payload.claimedByUserId).toBe(agentA.userId);
    },
    15000,
  );

  it(
    'an agent in a different workspace never receives another workspace\'s escalation broadcast',
    async () => {
      const northwind = await registerOwner('anas@northwind.com', 'Northwind Devices');
      const acme = await registerOwner('sam@acme.com', 'Acme Corp');
      const acmeAgent = await addMember(acme.workspaceId, 'agent@acme.com', MembershipRole.AGENT);
      await seedEmbeddedChunk(northwind.workspaceId, 'Refunds are available within 30 days of purchase.');

      const client = connectAgent(acmeAgent.token, acme.workspaceId);
      await waitFor(client, 'ready');

      let receivedAnything = false;
      client.on('session-escalated', () => {
        receivedAnything = true;
      });

      await triggerEscalation(northwind.token, northwind.workspaceId, 'session-1');
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(receivedAnything).toBe(false);
    },
    15000,
  );
});
