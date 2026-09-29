import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { OffsetPaginationQueryDto } from '../../../common/pagination/pagination-query.dto';
import { MembershipRole } from '../../../database/entities/membership-role.enum';

export class ListMembersQueryDto extends OffsetPaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsEnum(MembershipRole)
  role?: MembershipRole;
}
