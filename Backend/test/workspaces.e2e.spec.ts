import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as jwt from 'jsonwebtoken';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { User } from '../src/database/entities/user.entity';
import { Membership } from '../src/database/entities/membership.entity';
import { MembershipRole } from '../src/database/entities/membership-role.enum';

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
    await dataSource.query('TRUNCATE documents, refresh_tokens, memberships, users, workspaces RESTART IDENTITY');
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
    expect(ownWorkspaceRes.body).toEqual([{ userId: 1, email: 'anas@northwind.com', role: 'owner' }]);

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
});
