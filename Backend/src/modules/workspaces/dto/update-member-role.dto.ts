import { IsEnum } from 'class-validator';
import { MembershipRole } from '../../../database/entities/membership-role.enum';

export class UpdateMemberRoleDto {
  @IsEnum(MembershipRole)
  role: MembershipRole;
}
