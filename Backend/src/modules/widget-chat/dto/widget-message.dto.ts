import { IsString, MinLength } from 'class-validator';

export class WidgetMessageDto {
  @IsString()
  @MinLength(1)
  question: string;
}
