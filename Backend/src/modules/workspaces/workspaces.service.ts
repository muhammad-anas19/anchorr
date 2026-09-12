import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Membership } from '../../database/entities/membership.entity';
import { MembershipRole } from '../../database/entities/membership-role.enum';

@Injectable()
export class WorkspacesService {
  constructor(@InjectRepository(Membership) private readonly memberships: Repository<Membership>) {}

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
}
