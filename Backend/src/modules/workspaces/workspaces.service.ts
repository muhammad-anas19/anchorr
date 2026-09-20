import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Membership } from '../../database/entities/membership.entity';
import { MembershipRole } from '../../database/entities/membership-role.enum';
import { Workspace } from '../../database/entities/workspace.entity';

@Injectable()
export class WorkspacesService {
  constructor(
    @InjectRepository(Membership) private readonly memberships: Repository<Membership>,
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
  ) {}

  async listMembers(workspaceId: number) {
    const rows = await this.memberships.find({
      where: { workspaceId },
      relations: { user: true },
    });

    return rows.map((membership) => ({
      userId: membership.userId,
      email: membership.user.email,
      role: membership.role,
    }));
  }

  async updateMemberRole(workspaceId: number, targetUserId: number, role: MembershipRole) {
    const membership = await this.memberships.findOne({ where: { workspaceId, userId: targetUserId } });
    if (!membership) {
      throw new NotFoundException('This user is not a member of this workspace.');
    }

    membership.role = role;
    await this.memberships.save(membership);
    return { userId: targetUserId, role };
  }

  async getWidgetSettings(workspaceId: number) {
    const workspace = await this.findWorkspaceOrThrow(workspaceId);
    return { publicKey: workspace.publicKey, allowedOrigins: workspace.allowedOrigins };
  }

  async updateAllowedOrigins(workspaceId: number, allowedOrigins: string[]) {
    const workspace = await this.findWorkspaceOrThrow(workspaceId);
    workspace.allowedOrigins = allowedOrigins;
    await this.workspaces.save(workspace);
    return { publicKey: workspace.publicKey, allowedOrigins: workspace.allowedOrigins };
  }

  private async findWorkspaceOrThrow(workspaceId: number): Promise<Workspace> {
    const workspace = await this.workspaces.findOne({ where: { id: workspaceId } });
    if (!workspace) {
      throw new NotFoundException('Workspace not found.');
    }
    return workspace;
  }
}
