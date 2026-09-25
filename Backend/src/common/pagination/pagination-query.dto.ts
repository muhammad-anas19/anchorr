import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

// Query strings are always strings; @Type(() => Number) is what makes `?page=2` arrive as a
// number rather than "2" (the controller's ValidationPipe must run with transform: true).
export class OffsetPaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  // Capped deliberately: without a maximum, `?pageSize=1000000` is a free denial-of-service
  // against our own database from any authenticated member.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class CursorPaginationQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_CURSOR_LIMIT = 20;
