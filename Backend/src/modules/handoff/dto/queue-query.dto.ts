import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { OffsetPaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

// The tabs the console actually offers. Deliberately NOT the prototype's four
// (Waiting/Assigned/Active/Resolved): this system has no "assigned but not yet active"
// state — a session is escalated (waiting), claimed (a human owns it), or resolved. A fourth
// tab that can never contain a row would be a worse lie than three honest ones.
export const QUEUE_TABS = ['waiting', 'active', 'resolved', 'all'] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];

export const QUEUE_PRIORITIES = ['high', 'normal'] as const;
export type QueuePriority = (typeof QUEUE_PRIORITIES)[number];

export class QueueQueryDto extends OffsetPaginationQueryDto {
  @IsOptional()
  @IsIn(QUEUE_TABS)
  tab?: QueueTab;

  // Bounded because it reaches an ILIKE: an unbounded pattern is both a slow scan and a
  // pointless amount of user-controlled text to carry into the database.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsIn(QUEUE_PRIORITIES)
  priority?: QueuePriority;
}
