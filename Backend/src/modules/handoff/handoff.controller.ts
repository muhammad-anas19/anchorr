import { Controller, Get, Param, ParseIntPipe, Patch, Query, UseGuards, ValidationPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { MembershipRole } from '../../database/entities/membership-role.enum';
import { CursorPaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { QueueQueryDto } from './dto/queue-query.dto';
import { HandoffService } from './handoff.service';

// transform: true is what turns `?page=2` from the string "2" into a number, so the DTO's
// @IsInt actually has a number to validate. whitelist strips anything not declared.
const QUERY_PIPE = new ValidationPipe({ transform: true, whitelist: true });

@Controller('workspaces/:workspaceId/handoff')
@UseGuards(JwtAuthGuard, WorkspaceGuard, RolesGuard)
export class HandoffController {
  constructor(private readonly handoffService: HandoffService) {}

  @Get()
  @Roles(MembershipRole.OWNER, MembershipRole.AGENT)
  listActive(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
    return this.handoffService.listActive(workspaceId);
  }

  // Declared before ':sessionId' on purpose — Nest matches routes in declaration order, so a
  // literal segment registered after a parameter segment would never be reached ('queue'
  // would bind as a sessionId).
  @Get('queue')
  @Roles(MembershipRole.OWNER, MembershipRole.AGENT)
  listQueue(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Query(QUERY_PIPE) query: QueueQueryDto,
  ) {
    return this.handoffService.listQueue(workspaceId, query);
  }

  @Get('stats')
  @Roles(MembershipRole.OWNER, MembershipRole.AGENT)
  getStats(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
    return this.handoffService.getStats(workspaceId);
  }

  @Get('presence')
  @Roles(MembershipRole.OWNER, MembershipRole.AGENT)
  getPresence(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
    return this.handoffService.getPresence(workspaceId);
  }

  @Get('escalation-reasons')
  @Roles(MembershipRole.OWNER, MembershipRole.AGENT)
  getEscalationReasons(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
    return this.handoffService.getEscalationReasons(workspaceId);
  }

  @Get(':sessionId')
  @Roles(MembershipRole.OWNER, MembershipRole.AGENT)
  getDetail(@Param('workspaceId', ParseIntPipe) workspaceId: number, @Param('sessionId') sessionId: string) {
    return this.handoffService.getDetail(workspaceId, sessionId);
  }

  @Get(':sessionId/turns')
  @Roles(MembershipRole.OWNER, MembershipRole.AGENT)
  listTurns(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Param('sessionId') sessionId: string,
    @Query(QUERY_PIPE) query: CursorPaginationQueryDto,
  ) {
    return this.handoffService.listTurns(workspaceId, sessionId, query.cursor, query.limit);
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
