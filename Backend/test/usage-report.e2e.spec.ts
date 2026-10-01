import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { User } from '../src/database/entities/user.entity';
import { Membership } from '../src/database/entities/membership.entity';
import { MembershipRole } from '../src/database/entities/membership-role.enum';
import { resetDatabase } from './helpers/reset-database';

// Events are inserted directly with exact timestamps: the point of these tests is period
// arithmetic (boundaries, UTC days, zero-filling), which needs times the test controls.
describe('Usage report (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    jwtService = moduleRef.get(JwtService);
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
    token = res.body.accessToken;
  });

  let seq = 0;
  async function event(
    at: string,
    metric: 'answer' | 'chunk_embedded',
    attributes: Record<string, unknown>,
    { billable = true, workspaceId = 1 }: { billable?: boolean; workspaceId?: number } = {},
  ) {
    await dataSource.query(
      `INSERT INTO usage_events (workspace_id, metric, quantity, billable, occurred_at, idempotency_key, attributes)
       VALUES ($1, $2, 1, $3, $4, $5, $6)`,
      [workspaceId, metric, billable, at, `seed:${seq++}`, JSON.stringify(attributes)],
    );
  }
  const answered = { status: 'answered', cache: 'miss', promptTokens: 40, totalTokens: 60 };

  const report = (query = '', bearer = token) =>
    request(app.getHttpServer()).get(`/workspaces/1/usage${query}`).set('Authorization', `Bearer ${bearer}`);

  // [from, to): an event exactly at `from` is in; one exactly at `to` belongs to the NEXT
  // period. BETWEEN would count the boundary instant in both.
  it('uses a half-open range: includes `from`, excludes `to`', async () => {
    await event('2026-09-09T23:59:59.999Z', 'answer', answered); // before
    await event('2026-09-10T00:00:00.000Z', 'answer', answered); // exactly from → in
    await event('2026-09-12T23:59:59.999Z', 'answer', answered); // last instant → in
    await event('2026-09-13T00:00:00.000Z', 'answer', answered); // exactly to → out

    const res = await report('?from=2026-09-10T00:00:00Z&to=2026-09-13T00:00:00Z').expect(200);
    expect(res.body.answers.total).toBe(2);
    expect(res.body.range).toEqual({ from: '2026-09-10T00:00:00.000Z', to: '2026-09-13T00:00:00.000Z', timezone: 'UTC' });
  });

  it('breaks totals down by status, cache and billability, and sums tokens and characters', async () => {
    const at = '2026-09-10T10:00:00Z';
    await event(at, 'answer', answered);
    await event(at, 'answer', { status: 'answered', cache: 'hit', promptTokens: 0, totalTokens: 0 });
    await event(at, 'answer', { status: 'refused', cache: 'miss', promptTokens: null, totalTokens: null });
    await event(at, 'answer', { status: 'escalated', cache: 'miss', escalationReason: 'generation_failed' }, { billable: false });
    await event(at, 'chunk_embedded', { characters: 900 });
    await event(at, 'chunk_embedded', { characters: 100 });

    const res = await report('?from=2026-09-10T00:00:00Z&to=2026-09-11T00:00:00Z').expect(200);
    expect(res.body.answers).toEqual({
      total: 4,
      billable: 3,
      byStatus: { answered: 2, refused: 1, escalated: 1 },
      cacheHits: 1,
      promptTokens: 40,
      totalTokens: 60,
    });
    expect(res.body.chunksEmbedded).toEqual({ total: 2, billable: 2, characters: 1000 });
  });

  // UTC days, and every day present. 23:30 UTC on the 10th is 04:30 on the 11th in UTC+5 —
  // bucketed by a local clock it would land on the wrong day (the Phase 13 five-hour bug).
  it('returns one zero-filled row per UTC day, bucketing by UTC rather than any local clock', async () => {
    await event('2026-09-10T23:30:00Z', 'answer', answered);
    await event('2026-09-12T08:00:00Z', 'answer', answered);
    await event('2026-09-12T09:00:00Z', 'chunk_embedded', { characters: 10 });

    const res = await report('?from=2026-09-10T00:00:00Z&to=2026-09-13T00:00:00Z').expect(200);
    expect(res.body.daily).toEqual([
      { day: '2026-09-10', answers: 1, billableAnswers: 1, chunksEmbedded: 0, totalTokens: 60 },
      { day: '2026-09-11', answers: 0, billableAnswers: 0, chunksEmbedded: 0, totalTokens: 0 },
      { day: '2026-09-12', answers: 1, billableAnswers: 1, chunksEmbedded: 1, totalTokens: 60 },
    ]);
  });

  it('defaults to the current allowance period and reports the quota alongside', async () => {
    await dataSource.query(`UPDATE workspace_quotas SET used = 3`);
    await dataSource.query(
      `INSERT INTO usage_events (workspace_id, metric, quantity, billable, idempotency_key, attributes)
       VALUES (1, 'answer', 1, true, 'now-1', $1)`,
      [JSON.stringify(answered)],
    );

    const res = await report().expect(200);
    expect(res.body.quota).toMatchObject({ state: 'active', allowance: 200, used: 3, remaining: 197, source: 'trial' });
    expect(res.body.range.from).toBe(res.body.quota.periodStart);
    expect(res.body.range.to).toBe(res.body.quota.periodEnd);
    expect(res.body.answers.total).toBe(1);
    // Nothing has been asked through /ask in this test, so the whole burst is available.
    expect(res.body.rateLimit).toEqual({ burst: 20, perMinute: 20, available: 20 });
  });

  it('reports an ended trial as ended, and a workspace with no allowance as unlimited', async () => {
    await dataSource.query(`UPDATE workspace_quotas SET period_start = now() - interval '8 days', period_end = now() - interval '1 day'`);
    expect((await report().expect(200)).body.quota.state).toBe('ended');

    await dataSource.query(`DELETE FROM workspace_quotas`);
    expect((await report().expect(200)).body.quota).toEqual({ state: 'unlimited' });
  });

  it('never counts another workspace\'s usage', async () => {
    await dataSource.query(`INSERT INTO workspaces (name, public_key) VALUES ('Other', gen_random_uuid())`);
    await event('2026-09-10T10:00:00Z', 'answer', answered, { workspaceId: 2 });
    const res = await report('?from=2026-09-10T00:00:00Z&to=2026-09-11T00:00:00Z').expect(200);
    expect(res.body.answers.total).toBe(0);
  });

  it('rejects an inverted range, an oversized range, and a malformed date', async () => {
    await report('?from=2026-09-10T00:00:00Z&to=2026-09-10T00:00:00Z').expect(400);
    await report('?from=2025-01-01T00:00:00Z&to=2026-09-10T00:00:00Z').expect(400);
    await report('?from=last-tuesday').expect(400);
  });

  it('is owner-only', async () => {
    const agent = await dataSource.getRepository(User).save({ email: 'agent@northwind.com', passwordHash: 'x' });
    await dataSource.getRepository(Membership).save({ workspaceId: 1, userId: agent.id, role: MembershipRole.AGENT });
    await report('', await jwtService.signAsync({ sub: agent.id })).expect(403);
  });

  // The current period ends in the future. Its daily series must stop at today: a future day
  // is unknown, and a zero bar for it would read as "nothing happened".
  it('never returns daily rows for days that have not happened yet', async () => {
    const res = await report().expect(200); // the trial period: now → now + 7 days
    const [today] = await dataSource.query(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d`);
    expect(res.body.daily.map((d: { day: string }) => d.day)).toEqual([today.d]);
  });
});
