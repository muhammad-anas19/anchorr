import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { OffsetPaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

// 'expired' is filterable even though it is never stored — the list derives it from expires_at.
export const INVITATION_LIST_STATUSES = ['pending', 'expired', 'accepted', 'revoked'] as const;
export type InvitationListStatus = (typeof INVITATION_LIST_STATUSES)[number];

export class ListInvitationsQueryDto extends OffsetPaginationQueryDto {
  @IsOptional()
  @IsIn(INVITATION_LIST_STATUSES)
  status?: InvitationListStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
