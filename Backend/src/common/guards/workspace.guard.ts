import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Membership } from '../../database/entities/membership.entity';
import { TenantContextService } from '../../modules/tenancy/tenant-context.service';

@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    @InjectRepository(Membership) private readonly memberships: Repository<Membership>,
    private readonly tenantContext: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const workspaceId = Number(request.params.workspaceId);
    const userId = request.user?.userId;

    const membership = await this.memberships.findOne({ where: { workspaceId, userId } });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace.');
    }

    this.tenantContext.workspaceId = workspaceId;
    this.tenantContext.role = membership.role;
    return true;
  }
}
