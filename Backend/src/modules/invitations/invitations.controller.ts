import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, UseGuards, ValidationPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser, CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { Permission } from '../../common/permissions/permission.enum';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { InvitationsService, Inviter } from './invitations.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { ListInvitationsQueryDto } from './dto/list-invitations-query.dto';

const QUERY_PIPE = new ValidationPipe({ transform: true, whitelist: true });

// Every response is an InvitationSummary, which never contains the token — not on create, not
// on resend. The token exists in exactly one place outside the invitee's inbox: nowhere. If the
// API returned it, anyone with members.invite could skip the email and accept on the invitee's
// behalf, and the email-ownership check that accept relies on would mean nothing.
@Controller('workspaces/:workspaceId/invitations')
@UseGuards(JwtAuthGuard, WorkspaceGuard, PermissionsGuard)
@RequirePermission(Permission.MEMBERS_INVITE)
export class InvitationsController {
  // TenantContextService is request-scoped (Phase 2), which makes this controller request-scoped
  // too: Nest builds a fresh instance per request so it can hand over that request's context.
  constructor(
    private readonly invitations: InvitationsService,
    private readonly tenant: TenantContextService,
  ) {}

  @Post()
  create(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateInvitationDto,
  ) {
    return this.invitations.create(workspaceId, this.inviter(user), dto.email, dto.role);
  }

  @Get()
  list(@Param('workspaceId', ParseIntPipe) workspaceId: number, @Query(QUERY_PIPE) query: ListInvitationsQueryDto) {
    return this.invitations.list(workspaceId, query);
  }

  @Get(':invitationId')
  get(@Param('workspaceId', ParseIntPipe) workspaceId: number, @Param('invitationId', ParseIntPipe) invitationId: number) {
    return this.invitations.get(workspaceId, invitationId);
  }

  @Post(':invitationId/resend')
  resend(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Param('invitationId', ParseIntPipe) invitationId: number,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.invitations.resend(workspaceId, this.inviter(user), invitationId);
  }

  @Delete(':invitationId')
  revoke(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Param('invitationId', ParseIntPipe) invitationId: number,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.invitations.revoke(workspaceId, this.inviter(user), invitationId);
  }

  private inviter(user: CurrentUserPayload): Inviter {
    return { userId: user.userId, role: this.tenant.role };
  }
}
