import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import request from 'supertest';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { REDIS_CLIENT } from '../src/redis/redis.module';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../src/embedding/embedding-provider.interface';
import { ANSWER_GENERATION_PROVIDER } from '../src/generation/answer-generation-provider.interface';

describe('Widget chat gateway (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let embeddingProvider: EmbeddingProvider;
  let redis: Redis;
  let baseUrl: string;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ANSWER_GENERATION_PROVIDER)
      .useValue({ generate: async () => 'Refunds are available within 30 days [1].' })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    dataSource = moduleRef.get(DataSource);
    embeddingProvider = moduleRef.get(EMBEDDING_PROVIDER);
    redis = moduleRef.get(REDIS_CLIENT);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE conversations, document_chunks, document_contents, documents, refresh_tokens, memberships, users, workspaces RESTART IDENTITY',
    );
  });

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.disconnect();
    }
  });

  async function registerWorkspace(email: string, workspaceName: string, allowedOrigins: string[]) {
    const registerRes = await request(app.getHttpServer()).post('/auth/register').send({
      email,
      password: 'correct-horse-battery',
      workspaceName,
    });
    const token = registerRes.body.accessToken as string;
    const [{ workspace_id: workspaceId }] = await dataSource.query(
      `SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
      [email],
    );

    const settingsRes = await request(app.getHttpServer())
      .patch(`/workspaces/${workspaceId}/widget-settings`)
      .set('Authorization', `Bearer ${token}`)
      .send({ allowedOrigins })
      .expect(200);

    return { workspaceId: Number(workspaceId), publicKey: settingsRes.body.publicKey as string };
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

  function connectClient(publicKey: string, sessionId: string, origin: string): ClientSocket {
    const client = io(`${baseUrl}/widget`, {
      auth: { publicKey, sessionId },
      extraHeaders: { origin },
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
    'accepts a connection from an allowed origin with a valid public key, and answers a question over the socket',
    async () => {
      const { workspaceId, publicKey } = await registerWorkspace('anas@northwind.com', 'Northwind Devices', [
        'http://widget-host.example',
      ]);
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');

      const client = connectClient(publicKey, 'session-1', 'http://widget-host.example');
      await waitFor(client, 'connect');

      client.emit('message', { question: 'How many days for a refund?' });
      const answer = await waitFor<{ answer: string; status: string }>(client, 'answer');

      expect(answer.status).toBe('answered');
      expect(answer.answer.toLowerCase()).toContain('30 day');
    },
    15000,
  );

  it(
    'rejects a connection from an origin not on the workspace\'s allowlist',
    async () => {
      const { publicKey } = await registerWorkspace('anas@northwind.com', 'Northwind Devices', [
        'http://widget-host.example',
      ]);

      const client = connectClient(publicKey, 'session-1', 'http://attacker.example');
      await waitFor(client, 'disconnect');

      expect(client.connected).toBe(false);
    },
    10000,
  );

  it(
    'rejects a connection with an unknown public key',
    async () => {
      await registerWorkspace('anas@northwind.com', 'Northwind Devices', ['http://widget-host.example']);

      const client = connectClient('not-a-real-public-key', 'session-1', 'http://widget-host.example');
      await waitFor(client, 'disconnect');

      expect(client.connected).toBe(false);
    },
    10000,
  );

  it(
    'rejects a connection when the workspace has not configured any allowed origin yet (fails closed)',
    async () => {
      const { publicKey } = await registerWorkspace('anas@northwind.com', 'Northwind Devices', []);

      const client = connectClient(publicKey, 'session-1', 'http://widget-host.example');
      await waitFor(client, 'disconnect');

      expect(client.connected).toBe(false);
    },
    10000,
  );

  it(
    'never delivers one session\'s answer to a different session in the same workspace',
    async () => {
      const { workspaceId, publicKey } = await registerWorkspace('anas@northwind.com', 'Northwind Devices', [
        'http://widget-host.example',
      ]);
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');

      const sessionA = connectClient(publicKey, 'session-A', 'http://widget-host.example');
      const sessionB = connectClient(publicKey, 'session-B', 'http://widget-host.example');
      await Promise.all([waitFor(sessionA, 'connect'), waitFor(sessionB, 'connect')]);

      let sessionBReceivedAnything = false;
      sessionB.on('answer', () => {
        sessionBReceivedAnything = true;
      });

      sessionA.emit('message', { question: 'How many days for a refund?' });
      await waitFor(sessionA, 'answer');

      // Give session B a moment to (wrongly) receive a cross-session broadcast, if the room
      // scoping were broken.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sessionBReceivedAnything).toBe(false);
    },
    15000,
  );

  it(
    'survives a client disconnecting before its answer arrives, without crashing or leaking state',
    async () => {
      // A deliberately slow generation provider, so there's a real window to disconnect the
      // client mid-flight — after the server has already accepted the message and started
      // work, but before AnswerService resolves and the gateway tries to broadcast the result.
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ANSWER_GENERATION_PROVIDER)
        .useValue({
          generate: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return 'Refunds are available within 30 days [1].';
          },
        })
        .compile();
      const isolatedApp = moduleRef.createNestApplication();
      isolatedApp.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await isolatedApp.init();
      await isolatedApp.listen(0);
      const isolatedAddress = isolatedApp.getHttpServer().address();
      const isolatedBaseUrl = `http://127.0.0.1:${isolatedAddress.port}`;
      const isolatedDataSource = moduleRef.get(DataSource);
      const isolatedEmbeddingProvider = moduleRef.get(EMBEDDING_PROVIDER) as EmbeddingProvider;

      const registerRes = await request(isolatedApp.getHttpServer()).post('/auth/register').send({
        email: 'anas@northwind.com',
        password: 'correct-horse-battery',
        workspaceName: 'Northwind Devices',
      });
      const token = registerRes.body.accessToken as string;
      const [{ workspace_id: workspaceId }] = await isolatedDataSource.query(
        `SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
        ['anas@northwind.com'],
      );
      const settingsRes = await request(isolatedApp.getHttpServer())
        .patch(`/workspaces/${workspaceId}/widget-settings`)
        .set('Authorization', `Bearer ${token}`)
        .send({ allowedOrigins: ['http://widget-host.example'] })
        .expect(200);
      const publicKey = settingsRes.body.publicKey as string;

      const doc = await isolatedDataSource.query(
        `INSERT INTO documents (workspace_id, original_filename, storage_key, mime_type, file_size_bytes, content_hash, status)
         VALUES ($1, 'refunds.pdf', 'key-1', 'application/pdf', 10, $2, 'processing') RETURNING id`,
        [workspaceId, 'a'.repeat(64)],
      );
      const content = 'Refunds are available within 30 days of purchase.';
      const embedding = await isolatedEmbeddingProvider.embed(content);
      await isolatedDataSource.query(
        `INSERT INTO document_chunks (document_id, chunk_index, content, char_start, char_end, embedding)
         VALUES ($1, 0, $2, 0, $3, $4::vector)`,
        [doc[0].id, content, content.length, `[${embedding.join(',')}]`],
      );

      const doomedClient = io(`${isolatedBaseUrl}/widget`, {
        auth: { publicKey, sessionId: 'doomed-session' },
        extraHeaders: { origin: 'http://widget-host.example' },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      await new Promise<void>((resolve, reject) => {
        doomedClient.once('connect', () => resolve());
        doomedClient.once('connect_error', reject);
      });

      // Prediction: the in-flight AnswerService.answer() call keeps running to completion on
      // the server even after the socket that triggered it is gone (Node doesn't cancel a
      // promise just because nobody's listening anymore), and Socket.IO's `.to(room).emit()`
      // against a now-empty room is a documented no-op, not a throw — so nothing should crash,
      // and the server should still work normally for the next, unrelated connection.
      doomedClient.emit('message', { question: 'How many days for a refund?' });
      doomedClient.disconnect();

      // Long enough for the artificially slowed 1s generation call to finish server-side and
      // attempt the now-empty-room broadcast.
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const healthyClient = io(`${isolatedBaseUrl}/widget`, {
        auth: { publicKey, sessionId: 'healthy-session' },
        extraHeaders: { origin: 'http://widget-host.example' },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      clients.push(healthyClient);
      await new Promise<void>((resolve, reject) => {
        healthyClient.once('connect', () => resolve());
        healthyClient.once('connect_error', reject);
      });
      healthyClient.emit('message', { question: 'How many days for a refund?' });
      const answer = await waitFor<{ answer: string; status: string }>(healthyClient, 'answer');
      expect(answer.status).toBe('answered');

      await isolatedApp.close();
    },
    15000,
  );

  it(
    'throttles a public key past 20 messages per minute',
    async () => {
      const { workspaceId, publicKey } = await registerWorkspace('anas@northwind.com', 'Northwind Devices', [
        'http://widget-host.example',
      ]);
      await seedEmbeddedChunk(workspaceId, 'Refunds are available within 30 days of purchase.');
      await redis.del(`widget-messages:${publicKey}`);

      const client = connectClient(publicKey, 'session-1', 'http://widget-host.example');
      await waitFor(client, 'connect');

      for (let i = 0; i < 20; i++) {
        client.emit('message', { question: 'How many days for a refund?' });
        await waitFor(client, 'answer');
      }

      client.emit('message', { question: 'How many days for a refund?' });
      const error = await waitFor<{ message: string } | string>(client, 'exception');
      const message = typeof error === 'string' ? error : error.message;
      expect(String(message)).toContain('Too many messages');
    },
    30000,
  );
});
