import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../src/embedding/embedding-provider.interface';
import { ANSWER_GENERATION_PROVIDER } from '../src/generation/answer-generation-provider.interface';
import { CONFIDENT_DISTANCE_THRESHOLD } from '../src/modules/answer/answer.service';

// Real Gemini embeddings throughout — the whole phase is about how semantic and lexical
// search disagree, and a fake embedding provider would make that disagreement fictional.
// Only the GENERATION call is substituted, for the reason established in Phases 7 and 11:
// it is the quota-limited one, and none of these assertions are about what the model writes.
describe('Hybrid search (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let embeddingProvider: EmbeddingProvider;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ANSWER_GENERATION_PROVIDER)
      .useValue({
        generate: async () => ({ text: 'Stubbed answer [1]', promptTokens: 10, totalTokens: 20 }),
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
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

  async function register(email: string, workspaceName: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'correct-horse-battery', workspaceName });
    const [{ workspace_id: workspaceId }] = await dataSource.query(
      `SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
      [email],
    );
    return { token: res.body.accessToken as string, workspaceId: Number(workspaceId) };
  }

  async function seedDocument(workspaceId: number, filename: string, chunks: string[]): Promise<void> {
    const suffix = `${filename}-${workspaceId}`;
    const doc = await dataSource.query(
      `INSERT INTO documents (workspace_id, original_filename, storage_key, mime_type, file_size_bytes, content_hash, status)
       VALUES ($1, $2, $3, 'application/pdf', 10, $4, 'ready') RETURNING id`,
      [workspaceId, filename, `key-${suffix}`, suffix.repeat(8).slice(0, 64).padEnd(64, '0')],
    );
    for (const [index, content] of chunks.entries()) {
      const embedding = await embeddingProvider.embed(content);
      await dataSource.query(
        `INSERT INTO document_chunks (document_id, chunk_index, content, char_start, char_end, embedding)
         VALUES ($1, $2, $3, 0, $4, $5::vector)`,
        [doc[0].id, index, content, content.length, `[${embedding.join(',')}]`],
      );
    }
  }

  function retrieve(token: string, workspaceId: number, query: string, k = 5) {
    return request(app.getHttpServer())
      .post(`/workspaces/${workspaceId}/retrieve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ query, k })
      .expect(201);
  }

  // Filler chunks so the target is not trivially the only thing in the corpus — without
  // these, any ranking at all would "find" it and the test would prove nothing.
  const DISTRACTORS = [
    'Our warehouse ships orders Monday through Friday, excluding public holidays.',
    'Refunds are available within 30 days of purchase, provided the item is unused.',
    'You can change your billing address from the account settings page at any time.',
    'Support is available in English, French and German during business hours.',
  ];

  describe('the case the phase exists for', () => {
    // This corpus is built from a real measurement, not from the textbook story. Against this
    // project's embedding model, an exact token in an ON-topic chunk is found by vector search
    // perfectly well (measured 0.25-0.32). The failure only appears when the rare token sits
    // inside a chunk about something ELSE, while another chunk is a strong semantic match for
    // the question but does not contain the token. Then the semantically-plausible decoy
    // outranks the chunk that actually holds the answer.
    const BURIED_CODE =
      'Appendix C: warranty claim postage rates by region, including surcharges for islands ' +
      'and remote addresses. Claims are processed in the order received. Note: E-4021. ' +
      'Postage is refunded only when the claim is upheld.';
    const ON_TOPIC_DECOY =
      'If your device shows an error code, first restart the device and check for firmware ' +
      'updates. If the error persists, contact support and we will help you resolve it.';

    // A corpus of plausible near-misses. Every one of these is *about* device errors, so they
    // all sit close to an error-shaped question in embedding space and crowd out anything
    // that is not obviously on-topic.
    const ERROR_NEIGHBOURS = [
      'If your device shows an error code, restart it and check for firmware updates.',
      'Common device errors are listed in the troubleshooting appendix of the manual.',
      'Error messages on the display usually clear themselves after a power cycle.',
      'When a device reports a fault, support will ask you for the code shown on screen.',
      'Firmware update failures can leave the device showing an error until it is retried.',
      'Diagnostic codes help our engineers identify which component has failed.',
    ];

    it(
      'keyword search independently pins the exact token, with perfect precision',
      async () => {
        const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
        await seedDocument(workspaceId, 'handbook.pdf', [...ERROR_NEIGHBOURS, BURIED_CODE, ...DISTRACTORS]);

        const res = await retrieve(token, workspaceId, 'E-4021', 5);
        const buried = res.body.chunks.find((c: { content: string }) => c.content.includes('E-4021'));

        // Exactly one chunk contains the token, and the lexical side ranks precisely it
        // first — no near-misses, no ordering ambiguity. This is the property keyword search
        // contributes to the system, independent of whether the vector side also found it.
        expect(buried).toBeDefined();
        expect(buried.keywordRank).toBe(1);
        expect(res.body.chunks[0].content).toContain('E-4021');
        const otherKeywordHits = res.body.chunks.filter(
          (c: { keywordRank: number | null; content: string }) =>
            c.keywordRank !== null && !c.content.includes('E-4021'),
        );
        expect(otherKeywordHits).toHaveLength(0);
      },
      30000,
    );

    // This test encodes a SURPRISING MEASUREMENT, not a requirement. The textbook motivation
    // for hybrid search is that embeddings smear rare exact tokens — and against this
    // project's actual model that did not reproduce: across six probed scenarios (bare code,
    // code in a long chunk, SKU, version number, and two adversarial layouts) vector search
    // ranked the right chunk first every time but one, always inside the 0.45 threshold.
    //
    // It is asserted here so the day it stops being true is VISIBLE — a model swap, a
    // dimension change, or a much larger corpus would make hybrid search's contribution real
    // in a way it currently is not. See the phase doc's "What the measurements actually
    // showed" section.
    it(
      'documents that the current embedding model handles rare exact tokens unaided',
      async () => {
        const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
        await seedDocument(workspaceId, 'handbook.pdf', [...ERROR_NEIGHBOURS, BURIED_CODE, ...DISTRACTORS]);

        const res = await retrieve(token, workspaceId, 'E-4021', 5);
        const buried = res.body.chunks.find((c: { content: string }) => c.content.includes('E-4021'));

        expect(buried.vectorRank).not.toBeNull();
        expect(buried.vectorRank).toBeLessThanOrEqual(5);
        expect(buried.distance).toBeLessThan(CONFIDENT_DISTANCE_THRESHOLD);
      },
      30000,
    );
  });

  describe('what must not regress', () => {
    it(
      'still answers a pure paraphrase, where the question shares no words with the chunk',
      async () => {
        const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
        await seedDocument(workspaceId, 'policy.pdf', [
          'Refunds are available within 30 days of purchase, provided the item is unused.',
          'Our warehouse ships orders Monday through Friday.',
        ]);

        const res = await retrieve(token, workspaceId, 'How do I get my money back?');

        expect(res.body.chunks[0].content).toContain('Refunds are available');
        // Proves the vector side carried it: zero words are shared, so keyword search found
        // nothing at all and contributed nothing to the ranking.
        expect(res.body.chunks[0].keywordRank).toBeNull();
        expect(res.body.chunks[0].vectorRank).toBe(1);
      },
      30000,
    );

    it(
      'refuses a question that matches nothing either semantically or lexically',
      async () => {
        const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
        await seedDocument(workspaceId, 'policy.pdf', DISTRACTORS);

        const res = await request(app.getHttpServer())
          .post(`/workspaces/${workspaceId}/ask`)
          .set('Authorization', `Bearer ${token}`)
          .send({ question: 'What is the capital of France?' })
          .expect(201);

        expect(res.body.status).toBe('refused');
      },
      30000,
    );

    it(
      'never leaks another workspace via the keyword path',
      async () => {
        const northwind = await register('anas@northwind.com', 'Northwind Devices');
        const acme = await register('sam@acme.com', 'Acme Corp');
        await seedDocument(acme.workspaceId, 'acme.pdf', [
          'Error code E-4021 means the device firmware is out of date.',
        ]);

        // An exact-token query that would certainly match if scoping were broken.
        const res = await retrieve(northwind.token, northwind.workspaceId, 'E-4021');

        // Phase 13 opened a SECOND path into this data. Tenant isolation had to be re-proven
        // on the keyword side: the `candidates` CTE filters by workspace before either search
        // runs, so neither can reach another tenant's rows.
        expect(res.body.chunks).toHaveLength(0);
      },
      30000,
    );
  });

  describe('fusion and degenerate inputs', () => {
    it(
      'ranks a chunk found by both searches above one found by only a single search',
      async () => {
        const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
        await seedDocument(workspaceId, 'policy.pdf', [
          // Matches the question both lexically ("refund") and semantically.
          'Refunds are available within 30 days of purchase, provided the item is unused.',
          // Lexically overlapping only — shares "refund" but is about something else.
          'Refund requests from partner resellers follow the wholesale agreement instead.',
          ...DISTRACTORS.slice(0, 2),
        ]);

        const res = await retrieve(token, workspaceId, 'refund policy for unused items');
        const top = res.body.chunks[0];

        // Agreement between the two searches is exactly what RRF rewards.
        expect(top.vectorRank).not.toBeNull();
        expect(top.keywordRank).not.toBeNull();
        expect(top.rrfScore).toBeGreaterThan(res.body.chunks[1].rrfScore);
      },
      30000,
    );

    // Found by deliberately probing what a lexeme can contain, not by a failing test.
    // to_tsvector('english', 'https://example.com/a:b') yields the lexeme `/a:b`; pasted
    // unquoted into a tsquery, `:b` is read as a WEIGHT FILTER and becomes `'/a':B`. Since
    // plain to_tsvector assigns weight D to everything in content_tsv, the term then matches
    // nothing — silently, with no error. This asserts the quoting that prevents it.
    it(
      'treats a URL containing a colon as a literal term, not as a tsquery weight filter',
      async () => {
        const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
        await seedDocument(workspaceId, 'links.pdf', [
          'The status dashboard lives at https://example.com/a:b and updates every minute.',
          ...DISTRACTORS,
        ]);

        const res = await retrieve(token, workspaceId, 'where is https://example.com/a:b hosted?');
        const target = res.body.chunks.find((c: { content: string }) => c.content.includes('example.com/a:b'));

        expect(target).toBeDefined();
        // The keyword side must actually have matched it. Before the fix this was null: the
        // weight filter made the term unmatchable and only the vector side found the chunk.
        expect(target.keywordRank).not.toBeNull();
      },
      30000,
    );

    it(
      'degrades to pure vector search when the question is only stop words',
      async () => {
        const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
        await seedDocument(workspaceId, 'policy.pdf', [DISTRACTORS[1]]);

        // to_tsvector('english', 'the and of it') is empty, so string_agg returns NULL and
        // to_tsquery(NULL) is NULL. This must contribute nothing rather than error.
        const res = await retrieve(token, workspaceId, 'the and of it');

        expect(res.body.chunks.length).toBeGreaterThan(0);
        expect(res.body.chunks[0].keywordRank).toBeNull();
        expect(res.body.chunks[0].vectorRank).toBe(1);
      },
      30000,
    );

    it(
      'caps the candidate pool, so a word matching everything cannot flood the results',
      async () => {
        const { token, workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
        // Every chunk contains "available", so the keyword side matches all of them. The
        // final k is what stops an unselective term from dominating the response.
        await seedDocument(workspaceId, 'policy.pdf', [
          'Support is available in English during business hours.',
          'Refunds are available within 30 days of purchase.',
          'Spare parts are available for most discontinued models.',
          'Training sessions are available on request for enterprise plans.',
          'Invoices are available to download from the billing page.',
          'Priority shipping is available at checkout for an extra fee.',
        ]);

        const res = await retrieve(token, workspaceId, 'available', 3);

        expect(res.body.chunks).toHaveLength(3);
        expect(res.body.chunks.every((c: { keywordRank: number | null }) => c.keywordRank !== null)).toBe(true);
      },
      30000,
    );
  });

  describe('the generated tsvector column', () => {
    it('is maintained by Postgres on insert and on update, and never by application code', async () => {
      const { workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedDocument(workspaceId, 'policy.pdf', ['Refunds are available within 30 days.']);

      const [before] = await dataSource.query(
        `SELECT content_tsv::text AS tsv FROM document_chunks WHERE document_id = 1 AND chunk_index = 0`,
      );
      // Stemmed and stop-worded by Postgres, with no application involvement at all.
      expect(before.tsv).toContain("'refund'");
      expect(before.tsv).not.toContain("'are'");

      await dataSource.query(
        `UPDATE document_chunks SET content = 'Shipping is free on orders over fifty dollars.' WHERE document_id = 1 AND chunk_index = 0`,
      );

      const [after] = await dataSource.query(
        `SELECT content_tsv::text AS tsv FROM document_chunks WHERE document_id = 1 AND chunk_index = 0`,
      );
      // The whole reason for GENERATED ALWAYS: the index cannot drift from the text.
      expect(after.tsv).toContain("'ship'");
      expect(after.tsv).not.toContain("'refund'");
    });

    it('rejects any attempt to write it directly', async () => {
      const { workspaceId } = await register('anas@northwind.com', 'Northwind Devices');
      await seedDocument(workspaceId, 'policy.pdf', ['Refunds are available within 30 days.']);

      await expect(
        dataSource.query(`UPDATE document_chunks SET content_tsv = to_tsvector('english','anything') WHERE id = 1`),
      ).rejects.toThrow();
    });
  });
});
