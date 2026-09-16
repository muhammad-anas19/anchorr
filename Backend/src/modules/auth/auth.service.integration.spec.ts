import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AppDataSource } from '../../database/data-source';
import { User } from '../../database/entities/user.entity';
import { Workspace } from '../../database/entities/workspace.entity';
import { Membership } from '../../database/entities/membership.entity';
import { RefreshToken } from '../../database/entities/refresh-token.entity';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

describe('AuthService (integration)', () => {
  let authService: AuthService;

  beforeAll(async () => {
    await AppDataSource.initialize();

    const configService = {
      get: (key: string) => process.env[key],
    } as unknown as ConfigService;

    const jwtService = new JwtService({ secret: process.env.JWT_SECRET });

    authService = new AuthService(
      AppDataSource.getRepository(User),
      AppDataSource.getRepository(Workspace),
      AppDataSource.getRepository(Membership),
      AppDataSource.getRepository(RefreshToken),
      new PasswordService(),
      jwtService,
      configService,
    );
  });

  afterAll(async () => {
    await AppDataSource.destroy();
  });

  beforeEach(async () => {
    await AppDataSource.query('TRUNCATE document_contents, documents, refresh_tokens, memberships, users, workspaces RESTART IDENTITY');
  });

  it('registers a user, creates their workspace, and makes them owner', async () => {
    const tokens = await authService.register({
      email: 'anas@northwind.com',
      password: 'correct-horse-battery',
      workspaceName: 'Northwind Devices',
    });

    expect(tokens.accessToken).toBeDefined();
    expect(tokens.refreshToken).toBeDefined();

    const membershipRepo = AppDataSource.getRepository(Membership);
    const memberships = await membershipRepo.find();
    expect(memberships).toHaveLength(1);
    expect(memberships[0].role).toBe('owner');
  });

  it('rejects registering the same email twice', async () => {
    await authService.register({
      email: 'anas@northwind.com',
      password: 'correct-horse-battery',
      workspaceName: 'Northwind Devices',
    });

    await expect(
      authService.register({
        email: 'anas@northwind.com',
        password: 'different-password',
        workspaceName: 'Another Workspace',
      }),
    ).rejects.toThrow();
  });

  it('logs in with correct credentials and rejects the wrong password', async () => {
    await authService.register({
      email: 'anas@northwind.com',
      password: 'correct-horse-battery',
      workspaceName: 'Northwind Devices',
    });

    await expect(
      authService.login({ email: 'anas@northwind.com', password: 'correct-horse-battery' }),
    ).resolves.toHaveProperty('accessToken');

    await expect(
      authService.login({ email: 'anas@northwind.com', password: 'wrong-password' }),
    ).rejects.toThrow();
  });

  it('rotates the refresh token and rejects reuse of the old one', async () => {
    const { refreshToken } = await authService.register({
      email: 'anas@northwind.com',
      password: 'correct-horse-battery',
      workspaceName: 'Northwind Devices',
    });

    const rotated = await authService.refresh(refreshToken);
    expect(rotated.refreshToken).not.toEqual(refreshToken);

    await expect(authService.refresh(refreshToken)).rejects.toThrow();
  });

  it('revokes a refresh token on logout, blocking future refreshes with it', async () => {
    const { refreshToken } = await authService.register({
      email: 'anas@northwind.com',
      password: 'correct-horse-battery',
      workspaceName: 'Northwind Devices',
    });

    await authService.logout(refreshToken);

    await expect(authService.refresh(refreshToken)).rejects.toThrow();
  });
});
