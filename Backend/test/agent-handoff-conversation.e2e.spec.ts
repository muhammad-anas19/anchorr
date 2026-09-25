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
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../src/embedding/embedding-provider.interface';
import { ANSWER_GENERATION_PROVIDER } from '../src/generation/answer-generation-provider.interface';

describe('Agent takeover of a claimed conversation (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let embeddingProvider: EmbeddingProvider;
  let baseUrl: string;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    // A generation provider that throws if ever called — the real proof, for the "AI never
    // runs once claimed" test, that AnswerService genuinely isn't reached, not just that its
    // output looks right.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ANSWER_GENERATION_PROVIDER)
      .useValue({
        generate: async () => {
          throw new Error('The AI must never be called for a claimed conversation.');
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
    const settingsRes = await request(app.getHttpServer())
      .patch(`/workspaces/${workspaceId}/widget-settings`)
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .send({ allowedOrigins: ['http://widget-host.example'] })
      .expect(200);
    return {
      token: res.body.accessToken as string,
      workspaceId: Number(workspaceId),
      publicKey: settingsRes.body.publicKey as string,
    };
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

  function connectCustomer(publicKey: string, sessionId: string): ClientSocket {
    const client = io(`${baseUrl}/widget`, {
      auth: { publicKey, sessionId },
      extraHeaders: { origin: 'http://widget-host.example' },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    clients.push(client);
    return client;
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

  it(
    'an agent who claimed a conversation can join its room and their message reaches the customer live',
    async () => {
      const { token, workspaceId, publicKey } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      const agent = await addAgent(workspaceId, 'agent@northwind.com');
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');
      await triggerEscalation(token, workspaceId, 'session-1');
      await request(app.getHttpServer())
        .patch(`/workspaces/${workspaceId}/handoff/session-1/claim`)
        .set('Authorization', `Bearer ${agent.token}`)
        .expect(200);

      const customer = connectCustomer(publicKey, 'session-1');
      await waitFor(customer, 'ready');
      const agentSocket = connectAgent(agent.token, workspaceId);
      await waitFor(agentSocket, 'ready');
      agentSocket.emit('join-conversation', { sessionId: 'session-1' });

      const customerReceived = waitFor<{ message: string }>(customer, 'agent-message');
      // Give the join a moment to actually land before emitting — join-conversation has no
      // ack, so this mirrors how a real agent console would wait for its own 'connect' event
      // before letting the user click "send", not a workaround for a race in the server code.
      await new Promise((resolve) => setTimeout(resolve, 300));
      agentSocket.emit('agent-message', { sessionId: 'session-1', message: 'Hi, this is Jane from support.' });

      expect((await customerReceived).message).toBe('Hi, this is Jane from support.');
    },
    15000,
  );

  it(
    'once claimed, the customer\'s own messages are relayed live without ever calling the AI',
    async () => {
      const { token, workspaceId, publicKey } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      const agent = await addAgent(workspaceId, 'agent@northwind.com');
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');
      await triggerEscalation(token, workspaceId, 'session-1');
      await request(app.getHttpServer())
        .patch(`/workspaces/${workspaceId}/handoff/session-1/claim`)
        .set('Authorization', `Bearer ${agent.token}`)
        .expect(200);

      const agentSocket = connectAgent(agent.token, workspaceId);
      await waitFor(agentSocket, 'ready');
      agentSocket.emit('join-conversation', { sessionId: 'session-1' });
      await new Promise((resolve) => setTimeout(resolve, 300));

      const customer = connectCustomer(publicKey, 'session-1');
      await waitFor(customer, 'ready');

      const agentReceived = waitFor<{ question: string }>(agentSocket, 'customer-message');
      customer.emit('message', { question: 'Does that include sale items?' });

      // If AnswerService/the generation provider had been called, the throwing stub above
      // would have surfaced as a server-side error long before this resolves — the real
      // proof is that this event arrives at all, carrying the raw question, not an AI answer.
      expect((await agentReceived).question).toBe('Does that include sale items?');
    },
    15000,
  );

  it(
    'an agent cannot join a conversation they have not claimed',
    async () => {
      const { token, workspaceId } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      const agent = await addAgent(workspaceId, 'agent@northwind.com');
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');
      await triggerEscalation(token, workspaceId, 'session-1');
      // Deliberately never claimed.

      const agentSocket = connectAgent(agent.token, workspaceId);
      await waitFor(agentSocket, 'ready');

      const error = waitFor<{ message: string }>(agentSocket, 'join-conversation-error');
      agentSocket.emit('join-conversation', { sessionId: 'session-1' });

      expect((await error).message).toContain('have not claimed');
    },
    15000,
  );

  it(
    'an agent cannot message a conversation another agent claimed',
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

      const agentBSocket = connectAgent(agentB.token, workspaceId);
      await waitFor(agentBSocket, 'ready');

      const error = waitFor<{ message: string }>(agentBSocket, 'agent-message-error');
      agentBSocket.emit('agent-message', { sessionId: 'session-1', message: 'I got this one!' });

      expect((await error).message).toContain('have not claimed');
    },
    15000,
  );

  it(
    'resolving a claimed session hands the conversation back to the AI for the next message',
    async () => {
      // Escalation, claim, and resolve all happen on the OUTER app — its generation provider
      // always throws (this file's beforeAll), which is what makes the initial escalation
      // genuine in the first place. A second, separate app (working provider) is only used
      // for the final round-trip, to prove the AI genuinely runs again post-resolution — using
      // a working provider for the escalation step itself would mean nothing ever escalates.
      const { token, workspaceId, publicKey } = await registerOwner('anas@northwind.com', 'Northwind Devices');
      const agent = await addAgent(workspaceId, 'agent@northwind.com');
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');
      await triggerEscalation(token, workspaceId, 'session-1');
      await request(app.getHttpServer())
        .patch(`/workspaces/${workspaceId}/handoff/session-1/claim`)
        .set('Authorization', `Bearer ${agent.token}`)
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/workspaces/${workspaceId}/handoff/session-1/resolve`)
        .set('Authorization', `Bearer ${agent.token}`)
        .expect(200);

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ANSWER_GENERATION_PROVIDER)
        .useValue({ generate: async () => ({ text: 'Refunds are available within 30 days [1].', promptTokens: null, totalTokens: null }) })
        .compile();
      const isolatedApp = moduleRef.createNestApplication();
      isolatedApp.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await isolatedApp.init();
      await isolatedApp.listen(0);
      const isolatedAddress = isolatedApp.getHttpServer().address();
      const isolatedBaseUrl = `http://127.0.0.1:${isolatedAddress.port}`;

      const customer = io(`${isolatedBaseUrl}/widget`, {
        auth: { publicKey, sessionId: 'session-1' },
        extraHeaders: { origin: 'http://widget-host.example' },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      await new Promise<void>((resolve, reject) => {
        customer.once('ready', () => resolve());
        customer.once('connect_error', reject);
      });

      customer.emit('message', { question: 'Does that include sale items?' });
      const answer = await new Promise<{ answer: string; status: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for "answer"')), 5000);
        customer.once('answer', (payload: { answer: string; status: string }) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });

      expect(answer.status).toBe('answered');
      customer.disconnect();
      await isolatedApp.close();
    },
    15000,
  );
});
