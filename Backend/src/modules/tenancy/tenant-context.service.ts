import { Injectable, Scope } from '@nestjs/common';
import { MembershipRole } from '../../database/entities/membership-role.enum';

@Injectable({ scope: Scope.REQUEST })
export class TenantContextService {
  workspaceId!: number;
  role!: MembershipRole;
}
