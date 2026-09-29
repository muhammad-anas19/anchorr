import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, MaxLength } from 'class-validator';
import { MembershipRole } from '../../../database/entities/membership-role.enum';
import { normalizeEmail } from '../../../common/utils/normalize-email';

export class CreateInvitationDto {
  @Transform(({ value }) => (typeof value === 'string' ? normalizeEmail(value) : value))
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsEnum(MembershipRole)
  role!: MembershipRole;
}
