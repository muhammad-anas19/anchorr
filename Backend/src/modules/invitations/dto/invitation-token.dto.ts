import { IsString, Length, Matches, MinLength } from 'class-validator';

// The token travels in a POST body, never the URL: request bodies are not written to access
// logs, proxies or browser history the way paths and query strings are. (The email link keeps
// it in the #fragment for the same reason — see InvitationsService.sendInvitationEmail.)
export class InvitationTokenDto {
  @IsString()
  @Length(43, 43)
  @Matches(/^[A-Za-z0-9_-]+$/)
  token!: string;
}

export class AcceptWithSignupDto extends InvitationTokenDto {
  // Same rule as RegisterDto. No email field on purpose: the account is created with the
  // address the invitation was sent to, which is the address that just proved it received it.
  @IsString()
  @MinLength(8)
  password!: string;
}
