import { IsISO8601, IsOptional } from 'class-validator';

// Both optional: with neither, the report covers the current allowance period (or the last
// 30 days for a workspace without one). ISO-8601 instants, read as a half-open [from, to).
export class UsageQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
