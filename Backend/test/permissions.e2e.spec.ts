import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { User } from '../src/database/entities/user.entity';
import { Membership } from '../src/database/entities/membership.entity';
import { MembershipRole } from '../src/database/entities/membership-role.enum';
import { PermissionsService } from '../src/modules/tenancy/permissions.service';
import { resetDatabase } from './helpers/reset-database';

// The permission matrix as an executable spec. It is written out by hand here rather than read
// from the database or the migration, so a change to either one that alters who-can-do-what
// fails this test and has to be made on purpose.
//
// Each row is one permission and one route that requires it. The routes are chosen so that none
// of them calls Gemini: "allowed" is proven by a 200, or a 404/409 about a nonexistent target
// (which still means the request got past the permission check).
type Call = { method: 'get' | 'patch' | 'delete'; path: string; body?: object };
const MATRIX: Array<{ permission: string; call: Call; owner: boolean; agent: boolean; viewer: boolean }> = [
  { permission: 'members.view', call: { method: 'get', path: '/members' }, owner: true, agent: true, viewer: true },
  {
    permission: 'members.manage',
    call: { method: 'patch', path: '/members/999', body: { role: 'agent' } },
    owner: true,
    agent: false,
    viewer: false,
  },
  { permission: 'documents.view', call: { method: 'get', path: '/documents' }, owner: true, agent: true, viewer: true },
  {
    permission: 'documents.manage',
    call: { method: 'delete', path: '/documents/999' },
    owner: true,
    agent: true,
    viewer: false,
  },
  { permission: 'knowledge.query', call: { method: 'get', path: '/ask/config' }, owner: true, agent: true, viewer: true },
  { permission: 'handoff.view', call: { method: 'get', path: '/handoff/stats' }, owner: true, agent: true, viewer: false },
  {
    permission: 'handoff.work',
    call: { method: 'patch', path: '/handoff/no-such-session/claim' },
    owner: true,
    agent: true,
    viewer: false,
  },
  { permission: 'widget.view', call: { method: 'get', path: '/widget-settings' }, owner: true, agent: false, viewer: false },
  {
    permission: 'widget.manage',
    call: { method: 'patch', path: '/widget-settings', body: { allowedOrigins: [] } },
    owner: true,
    agent: false,
    viewer: false,
  },
  { permission: 'usage.view', call: { method: 'get', path: '/usage' }, owner: true, agent: false, viewer: false },
];

describe('Permissions (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let permissions: PermissionsService;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    jwtService = moduleRef.get(JwtService);
    permissions = moduleRef.get(PermissionsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // permissions / role_permissions are deliberately NOT truncated: they are seed data owned by
    // the migration, not per-test state.
    await resetDatabase(dataSource);
    const res = await request(app.getHttpServer()).post('/auth/register').send({
      email: 'owner@northwind.com',
      password: 'correct-horse-battery',
      workspaceName: 'Northwind',
    });
    tokens.owner = res.body.accessToken;
    tokens.agent = await addMember('agent@northwind.com', MembershipRole.AGENT);
    tokens.viewer = await addMember('viewer@northwind.com', MembershipRole.VIEWER);
  });

  async function addMember(email: string, role: MembershipRole): Promise<string> {
    const user = await dataSource.getRepository(User).save({ email, passwordHash: 'unused' });
    await dataSource.getRepository(Membership).save({ workspaceId: 1, userId: user.id, role });
    return jwtService.signAsync({ sub: user.id });
  }

  function send(role: string, call: Call) {
    const req = request(app.getHttpServer())
      [call.method](`/workspaces/1${call.path}`)
      .set('Authorization', `Bearer ${tokens[role]}`);
    return call.body ? req.send(call.body) : req;
  }

  for (const row of MATRIX) {
    for (const role of ['owner', 'agent', 'viewer'] as const) {
      const allowed = row[role];
      it(`${role} ${allowed ? 'CAN' : 'cannot'} ${row.permission} (${row.call.method.toUpperCase()} ${row.call.path})`, async () => {
        const res = await send(role, row.call);
        if (allowed) {
          // Past the permission check: success, or a domain answer about the (nonexistent) target.
          // Not merely "not 403" — a 401 from a broken token or a 500 would also satisfy that.
          expect([200, 404, 409]).toContain(res.status);
        } else {
          expect(res.status).toBe(403);
          expect(res.body.message).toContain(row.permission);
        }
      });
    }
  }

  it('reports each membership\'s permissions on /auth/me', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me').set('Authorization', `Bearer ${tokens.viewer}`).expect(200);
    expect(res.body.memberships[0].permissions).toEqual(['documents.view', 'knowledge.query', 'members.view', 'workspace.leave']);
  });

  // The point of permissions living in a table: policy changes are data changes. Granting viewers
  // read access to the handoff queue needs no code and no deploy — an INSERT and a reload.
  it('applies a role_permissions change without any code change, once reloaded', async () => {
    const stats = () => send('viewer', { method: 'get', path: '/handoff/stats' });
    expect((await stats()).status).toBe(403);

    try {
      await dataSource.query(`INSERT INTO role_permissions (role, permission_key) VALUES ('viewer', 'handoff.view')`);
      // Still denied: the policy is cached in memory, so a database edit alone does nothing
      // until the cache is reloaded. That staleness is the price of not querying per request.
      expect((await stats()).status).toBe(403);

      await permissions.reload();
      expect((await stats()).status).toBe(200);
    } finally {
      await dataSource.query(`DELETE FROM role_permissions WHERE role = 'viewer' AND permission_key = 'handoff.view'`);
      await permissions.reload();
    }
  });

  // Drift: a permission the code checks for but the database does not have. Without the boot
  // check this is silent — every role would simply be denied, owners included.
  it('refuses to load when a permission defined in code is missing from the database', async () => {
    const grants: Array<{ role: string }> = await dataSource.query(
      `SELECT role FROM role_permissions WHERE permission_key = 'widget.manage'`,
    );
    const [{ description }] = await dataSource.query(`SELECT description FROM permissions WHERE key = 'widget.manage'`);

    try {
      await dataSource.query(`DELETE FROM permissions WHERE key = 'widget.manage'`); // cascades to its grants
      await expect(permissions.reload()).rejects.toThrow(/missing from the permissions table: widget\.manage/);
    } finally {
      await dataSource.query(`INSERT INTO permissions (key, description) VALUES ('widget.manage', $1)`, [description]);
      for (const { role } of grants) {
        await dataSource.query(`INSERT INTO role_permissions (role, permission_key) VALUES ($1, 'widget.manage')`, [role]);
      }
      await permissions.reload();
    }
    expect((await send('owner', { method: 'patch', path: '/widget-settings', body: { allowedOrigins: [] } })).status).toBe(200);
  });
});
