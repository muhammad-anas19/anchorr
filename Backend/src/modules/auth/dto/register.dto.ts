import { Transform } from 'class-transformer';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { normalizeEmail } from '../../../common/utils/normalize-email';

export class RegisterDto {
  // Normalised before validation and before the service ever sees it, so every account is
  // stored, looked up and compared in exactly one form.
  @Transform(({ value }) => (typeof value === 'string' ? normalizeEmail(value) : value))
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  @MinLength(1)
  workspaceName: string;
}
