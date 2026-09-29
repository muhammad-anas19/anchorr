import { ConflictException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { User } from '../src/database/entities/user.entity';
import { Membership } from '../src/database/entities/membership.entity';
import { MembershipRole } from '../src/database/entities/membership-role.enum';
import {
  WorkspacesService,
  assertAnotherOwnerRemains,
  lockWorkspace,
} from '../src/modules/workspaces/workspaces.service';
import { resetDatabase } from './helpers/reset-database';

describe('Workspace access control (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;

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
  });

  it('rejects an unauthenticated request to a workspace route', async () => {
    await request(app.getHttpServer()).get('/workspaces/1/members').expect(401);
  });

  it('lets a member list their own workspace, and blocks a workspace they do not belong to', async () => {
    const registerRes = await request(app.getHttpServer()).post('/auth/register').send({
      email: 'anas@northwind.com',
      password: 'correct-horse-battery',
      workspaceName: 'Northwind Devices',
    });
    const { accessToken } = registerRes.body;

    const ownWorkspaceRes = await request(app.getHttpServer())
      .get('/workspaces/1/members')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(ownWorkspaceRes.body).toMatchObject({
      items: [{ userId: 1, email: 'anas@northwind.com', role: 'owner', joinedAt: expect.any(String) }],
      total: 1,
      page: 1,
    });

    await request(app.getHttpServer())
      .get('/workspaces/999/members')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);
  });

  it('rejects a request with a garbage bearer token', async () => {
    await request(app.getHttpServer())
      .get('/workspaces/1/members')
      .set('Authorization', 'Bearer garbage.not.a.token')
      .expect(401);
  });

  it('rejects a well-formed JWT signed with the wrong secret', async () => {
    // Structurally a perfectly valid JWT — same shape, same claims a real one would have.
    // The only difference is it was never signed with this server's actual secret.
    const forgedToken = jwt.sign({ sub: 1 }, 'not-the-real-secret', { expiresIn: '15m' });

    await request(app.getHttpServer())
      .get('/workspaces/1/members')
      .set('Authorization', `Bearer ${forgedToken}`)
      .expect(401);
  });

  it('rejects an expired JWT even though it was signed with the correct secret', async () => {
    const expiredToken = jwtService.sign({ sub: 1 }, { expiresIn: '-1s' });

    await request(app.getHttpServer())
      .get('/workspaces/1/members')
      .set('Authorization', `Bearer ${expiredToken}`)
      .expect(401);
  });

  it('lets an owner change a member\'s role', async () => {
    const registerRes = await request(app.getHttpServer()).post('/auth/register').send({
      email: 'anas@northwind.com',
      password: 'correct-horse-battery',
      workspaceName: 'Northwind Devices',
    });
    const { accessToken: ownerToken } = registerRes.body;

    const viewerUser = await dataSource.getRepository(User).save({
      email: 'viewer@northwind.com',
      passwordHash: 'unused-in-this-test',
    });
    await dataSource.getRepository(Membership).save({
      workspaceId: 1,
      userId: viewerUser.id,
      role: MembershipRole.VIEWER,
    });

    await request(app.getHttpServer())
      .patch(`/workspaces/1/members/${viewerUser.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: MembershipRole.AGENT })
      .expect(200)
      .expect({ userId: viewerUser.id, role: MembershipRole.AGENT });
  });

  it('blocks a viewer from changing roles, but still lets them list members', async () => {
    await request(app.getHttpServer()).post('/auth/register').send({
      email: 'anas@northwind.com',
      password: 'correct-horse-battery',
      workspaceName: 'Northwind Devices',
    });

    const viewerUser = await dataSource.getRepository(User).save({
      email: 'viewer@northwind.com',
      passwordHash: 'unused-in-this-test',
    });
    await dataSource.getRepository(Membership).save({
      workspaceId: 1,
      userId: viewerUser.id,
      role: MembershipRole.VIEWER,
    });
    const viewerToken = await jwtService.signAsync({ sub: viewerUser.id });

    await request(app.getHttpServer())
      .patch('/workspaces/1/members/1')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ role: MembershipRole.OWNER })
      .expect(403);

    await request(app.getHttpServer())
      .get('/workspaces/1/members')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
  });

  describe('email normalisation', () => {
    it('stores a registered email in canonical form and logs in with any capitalisation', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: '  Anas@Northwind.COM ', password: 'correct-horse-battery', workspaceName: 'Northwind' })
        .expect(201);

      const [row] = await dataSource.query('SELECT email FROM users');
      expect(row.email).toBe('anas@northwind.com');

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'ANAS@northwind.com', password: 'correct-horse-battery' })
        .expect(200);
    });

    it('rejects a second account that differs only by capitalisation', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'anas@northwind.com', password: 'correct-horse-battery', workspaceName: 'Northwind' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'Anas@Northwind.com', password: 'correct-horse-battery', workspaceName: 'Northwind 2' })
        .expect(409);
    });

    it('has the database itself reject a non-canonical email from a path that skips the app', async () => {
      await expect(
        dataSource.query(`INSERT INTO users (email, password_hash) VALUES ('Mixed@Case.com', 'x')`),
      ).rejects.toThrow(/CHK_users_email_normalized/);
    });
  });

  describe('last-owner protection', () => {
    async function registerOwner() {
      const res = await request(app.getHttpServer()).post('/auth/register').send({
        email: 'anas@northwind.com',
        password: 'correct-horse-battery',
        workspaceName: 'Northwind Devices',
      });
      return res.body.accessToken as string;
    }

    async function addOwner(email: string) {
      const user = await dataSource.getRepository(User).save({ email, passwordHash: 'unused' });
      await dataSource.getRepository(Membership).save({ workspaceId: 1, userId: user.id, role: MembershipRole.OWNER });
      return { userId: user.id, token: await jwtService.signAsync({ sub: user.id }) };
    }

    async function ownerCount() {
      const [row] = await dataSource.query(`SELECT count(*)::int AS n FROM memberships WHERE workspace_id = 1 AND role = 'owner'`);
      return row.n as number;
    }

    it('refuses to demote the only owner (including demoting yourself)', async () => {
      const ownerToken = await registerOwner();

      await request(app.getHttpServer())
        .patch('/workspaces/1/members/1')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: MembershipRole.AGENT })
        .expect(409);

      expect(await ownerCount()).toBe(1);
    });

    it('allows demoting an owner when another owner remains', async () => {
      const ownerToken = await registerOwner();
      const second = await addOwner('second@northwind.com');

      await request(app.getHttpServer())
        .patch(`/workspaces/1/members/${second.userId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: MembershipRole.AGENT })
        .expect(200);

      expect(await ownerCount()).toBe(1);
    });

    // The write-skew case, made deterministic. Firing two HTTP requests at once is NOT enough:
    // verified by removing the lock, the HTTP version still passed every time, because the
    // first demotion committed before the second request even reached RolesGuard. So the test
    // plays one side by hand, pausing it at the exact dangerous moment — after it has counted
    // the owners, before it has written — while the real service runs the other side.
    it('leaves at least one owner when two owners demote each other concurrently', async () => {
      await registerOwner();
      const second = await addOwner('second@northwind.com');
      const service = app.get(WorkspacesService);

      const sideA = dataSource.createQueryRunner();
      await sideA.connect();
      await sideA.startTransaction();
      let serviceCall: Promise<unknown> | undefined;
      try {
        // Side A: the same steps updateMemberRole takes to demote user 1 — lock, then check.
        await lockWorkspace(sideA.manager, 1);
        await assertAnotherOwnerRemains(sideA.manager, 1); // sees 2 owners, passes

        // Side B: the real service demotes the second owner while A is still mid-flight.
        serviceCall = service.updateMemberRole(1, second.userId, MembershipRole.AGENT).then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        );
        const blocked = await waitUntilBlockedOrSettled(serviceCall);
        expect(blocked).toBe(true); // B is queued behind A's lock, not racing it

        await sideA.manager.update(Membership, { workspaceId: 1, userId: 1 }, { role: MembershipRole.AGENT });
        await sideA.commitTransaction();
      } finally {
        if (sideA.isTransactionActive) await sideA.rollbackTransaction();
        await sideA.release();
      }

      const outcome = (await serviceCall) as { ok: boolean; error?: unknown };
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBeInstanceOf(ConflictException);
      expect(await ownerCount()).toBe(1);
    });

    // True once some Postgres backend is waiting on a lock, or false if the promise settles
    // first (which is what happens when the lock is missing — B just runs straight through).
    async function waitUntilBlockedOrSettled(promise: Promise<unknown>): Promise<boolean> {
      let settled = false;
      promise.then(() => (settled = true));
      for (let i = 0; i < 100 && !settled; i++) {
        const [row] = await dataSource.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if (row.n > 0) return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return false;
    }
  });

  describe('member listing', () => {
    async function seedTeam() {
      const res = await request(app.getHttpServer()).post('/auth/register').send({
        email: 'anas@northwind.com',
        password: 'correct-horse-battery',
        workspaceName: 'Northwind Devices',
      });
      for (const [email, role] of [
        ['zed.agent@northwind.com', MembershipRole.AGENT],
        ['amy.agent@northwind.com', MembershipRole.AGENT],
        ['viewer@northwind.com', MembershipRole.VIEWER],
        ['100%sure@northwind.com', MembershipRole.VIEWER],
      ] as const) {
        const user = await dataSource.getRepository(User).save({ email, passwordHash: 'unused' });
        await dataSource.getRepository(Membership).save({ workspaceId: 1, userId: user.id, role });
      }
      return res.body.accessToken as string;
    }

    const list = (token: string, query: string) =>
      request(app.getHttpServer()).get(`/workspaces/1/members${query}`).set('Authorization', `Bearer ${token}`).expect(200);
    const emails = (body: { items: Array<{ email: string }> }) => body.items.map((m) => m.email);

    it('orders owners first, then agents, then viewers, alphabetically within each', async () => {
      const token = await seedTeam();
      expect(emails((await list(token, '')).body)).toEqual([
        'anas@northwind.com',
        'amy.agent@northwind.com',
        'zed.agent@northwind.com',
        '100%sure@northwind.com',
        'viewer@northwind.com',
      ]);
    });

    it('paginates on the server and reports the total', async () => {
      const token = await seedTeam();
      const res = await list(token, '?page=2&pageSize=2');
      expect(res.body).toMatchObject({ total: 5, page: 2, pageSize: 2, totalPages: 3 });
      expect(emails(res.body)).toEqual(['zed.agent@northwind.com', '100%sure@northwind.com']);
    });

    it('filters by role and searches by email, case-insensitively', async () => {
      const token = await seedTeam();
      expect(emails((await list(token, '?role=agent')).body)).toEqual(['amy.agent@northwind.com', 'zed.agent@northwind.com']);
      expect(emails((await list(token, '?search=AMY')).body)).toEqual(['amy.agent@northwind.com']);
    });

    // Premise: without escaping, "%" is a wildcard and "100%" would match any email containing
    // "100" — and "_" would match any single character.
    it('treats % and _ in a search as literal characters, not wildcards', async () => {
      const token = await seedTeam();
      expect(emails((await list(token, '?search=100%25')).body)).toEqual(['100%sure@northwind.com']);
      expect(emails((await list(token, '?search=%25')).body)).toEqual(['100%sure@northwind.com']);
      expect((await list(token, '?search=_')).body.total).toBe(0);
    });

    it('returns the real role → permission matrix, with descriptions', async () => {
      const token = await seedTeam();
      const res = await request(app.getHttpServer()).get('/workspaces/1/roles').set('Authorization', `Bearer ${token}`).expect(200);
      const viewer = res.body.find((r: { role: string }) => r.role === 'viewer');
      expect(viewer.permissions.map((p: { key: string }) => p.key)).toEqual([
        'documents.view',
        'knowledge.query',
        'members.view',
        'workspace.leave',
      ]);
      expect(viewer.permissions[0].description).toMatch(/documents/i);
    });
  });
});
