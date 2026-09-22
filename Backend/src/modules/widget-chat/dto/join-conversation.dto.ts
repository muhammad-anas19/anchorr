import { IsString, MinLength } from 'class-validator';

export class JoinConversationDto {
  @IsString()
  @MinLength(1)
  sessionId: string;
}
