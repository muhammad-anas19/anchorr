import { IsOptional, IsString, MinLength } from 'class-validator';

export class AskDto {
  @IsString()
  @MinLength(1)
  question: string;

  @IsOptional()
  @IsString()
  sessionId?: string;
}
