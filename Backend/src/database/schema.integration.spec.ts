import { randomUUID } from 'crypto';
import { AppDataSource } from './data-source';
import { Workspace } from './entities/workspace.entity';
import { User } from './entities/user.entity';
import { Membership } from './entities/membership.entity';
import { MembershipRole } from './entities/membership-role.enum';

describe('Workspace/User/Membership schema', () => {
  beforeAll(async () => {
    await AppDataSource.initialize();
  });

  afterAll(async () => {
    await AppDataSource.destroy();
  });

  beforeEach(async () => {
    await AppDataSource.query('TRUNCATE conversation_sessions, conversations, document_chunks, document_contents, documents, refresh_tokens, memberships, users, workspaces RESTART IDENTITY');
  });

  it('rejects a duplicate membership for the same workspace and user', async () => {
    const workspaceRepo = AppDataSource.getRepository(Workspace);
    const userRepo = AppDataSource.getRepository(User);
    const membershipRepo = AppDataSource.getRepository(Membership);

    const workspace = await workspaceRepo.save({ name: 'Northwind Devices', publicKey: randomUUID() });
    const user = await userRepo.save({ email: 'anas@northwind.com', passwordHash: 'hashed' });

    await membershipRepo.save({ workspaceId: workspace.id, userId: user.id, role: MembershipRole.OWNER });

    await expect(
      membershipRepo.save({ workspaceId: workspace.id, userId: user.id, role: MembershipRole.AGENT }),
    ).rejects.toThrow();
  });

  it('cascades: deleting a workspace deletes its memberships', async () => {
    const workspaceRepo = AppDataSource.getRepository(Workspace);
    const userRepo = AppDataSource.getRepository(User);
    const membershipRepo = AppDataSource.getRepository(Membership);

    const workspace = await workspaceRepo.save({ name: 'Northwind Devices', publicKey: randomUUID() });
    const user = await userRepo.save({ email: 'anas@northwind.com', passwordHash: 'hashed' });
    await membershipRepo.save({ workspaceId: workspace.id, userId: user.id, role: MembershipRole.OWNER });

    await workspaceRepo.delete(workspace.id);

    const remaining = await membershipRepo.find();
    expect(remaining).toHaveLength(0);
  });
});
