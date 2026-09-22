import { IsString, MinLength } from 'class-validator';

export class AgentMessageDto {
  @IsString()
  @MinLength(1)
  sessionId: string;

  @IsString()
  @MinLength(1)
  message: string;
}
