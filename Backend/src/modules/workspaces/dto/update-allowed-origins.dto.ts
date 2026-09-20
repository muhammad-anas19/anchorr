import { ArrayMaxSize, IsArray, Matches } from 'class-validator';

// scheme://host[:port] only — no path, no trailing slash. Origins are compared
// against the browser's own `Origin` header, which never includes a path.
const ORIGIN_PATTERN = /^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/;

export class UpdateAllowedOriginsDto {
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(ORIGIN_PATTERN, { each: true, message: 'Each origin must look like https://example.com (no path, no trailing slash)' })
  allowedOrigins: string[];
}
