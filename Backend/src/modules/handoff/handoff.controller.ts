import { Controller, Get, Param, ParseIntPipe, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { MembershipRole } from '../../database/entities/membership-role.enum';
import { HandoffService } from './handoff.service';

@Controller('workspaces/:workspaceId/handoff')
@UseGuards(JwtAuthGuard, WorkspaceGuard, RolesGuard)
export class HandoffController {
  constructor(private readonly handoffService: HandoffService) {}

  @Get()
  @Roles(MembershipRole.OWNER, MembershipRole.AGENT)
  listActive(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
    return this.handoffService.listActive(workspaceId);
  }

  @Get(':sessionId')
  @Roles(MembershipRole.OWNER, MembershipRole.AGENT)
  getDetail(@Param('workspaceId', ParseIntPipe) workspaceId: number, @Param('sessionId') sessionId: string) {
    return this.handoffService.getDetail(workspaceId, sessionId);
  }

  @Patch(':sessionId/claim')
  @Roles(MembershipRole.OWNER, MembershipRole.AGENT)
  claim(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.handoffService.claim(workspaceId, sessionId, user.userId);
  }

  @Patch(':sessionId/resolve')
  @Roles(MembershipRole.OWNER, MembershipRole.AGENT)
  resolve(@Param('workspaceId', ParseIntPipe) workspaceId: number, @Param('sessionId') sessionId: string) {
    return this.handoffService.resolve(workspaceId, sessionId);
  }
}
