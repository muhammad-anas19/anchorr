import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { InvitationAcceptanceService } from './invitation-acceptance.service';
import { AcceptWithSignupDto, InvitationTokenDto } from './dto/invitation-token.dto';

// The invitee's side. No WorkspaceGuard, no PermissionsGuard: the caller is not a member yet —
// becoming one is the whole point. Possession of the token IS the authorization here, which is
// why everything about the token (entropy, hashing, single use, expiry, email binding) matters.
@Controller('invitations')
export class PublicInvitationsController {
  constructor(private readonly acceptance: InvitationAcceptanceService) {}

  // POST, not GET /invitations/:token — keeps the token out of the URL and so out of logs.
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(@Body() dto: InvitationTokenDto) {
    return this.acceptance.preview(dto.token);
  }

  // For someone who already has an account: they must be signed in AS the invited address.
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  accept(@Body() dto: InvitationTokenDto, @CurrentUser() user: CurrentUserPayload) {
    return this.acceptance.acceptAsExistingUser(dto.token, user.userId);
  }

  // For someone with no account: creates it, joins the workspace, signs them in — one step.
  @Post('accept-signup')
  acceptWithSignup(@Body() dto: AcceptWithSignupDto) {
    return this.acceptance.acceptWithSignup(dto.token, dto.password);
  }
}
