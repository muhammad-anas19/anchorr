import { Controller, Get, Param, ParseIntPipe, Patch, Query, UseGuards, ValidationPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/permissions/permission.enum';
import { CurrentUser, CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { CursorPaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { QueueQueryDto } from './dto/queue-query.dto';
import { HandoffService } from './handoff.service';

// transform: true is what turns `?page=2` from the string "2" into a number, so the DTO's
// @IsInt actually has a number to validate. whitelist strips anything not declared.
const QUERY_PIPE = new ValidationPipe({ transform: true, whitelist: true });

@Controller('workspaces/:workspaceId/handoff')
@UseGuards(JwtAuthGuard, WorkspaceGuard, PermissionsGuard)
export class HandoffController {
  constructor(private readonly handoffService: HandoffService) {}

  @Get()
  @RequirePermission(Permission.HANDOFF_VIEW)
  listActive(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
    return this.handoffService.listActive(workspaceId);
  }

  // Declared before ':sessionId' on purpose — Nest matches routes in declaration order, so a
  // literal segment registered after a parameter segment would never be reached ('queue'
  // would bind as a sessionId).
  @Get('queue')
  @RequirePermission(Permission.HANDOFF_VIEW)
  listQueue(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Query(QUERY_PIPE) query: QueueQueryDto,
  ) {
    return this.handoffService.listQueue(workspaceId, query);
  }

  @Get('stats')
  @RequirePermission(Permission.HANDOFF_VIEW)
  getStats(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
    return this.handoffService.getStats(workspaceId);
  }

  @Get('presence')
  @RequirePermission(Permission.HANDOFF_VIEW)
  getPresence(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
    return this.handoffService.getPresence(workspaceId);
  }

  @Get('escalation-reasons')
  @RequirePermission(Permission.HANDOFF_VIEW)
  getEscalationReasons(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
    return this.handoffService.getEscalationReasons(workspaceId);
  }

  @Get(':sessionId')
  @RequirePermission(Permission.HANDOFF_VIEW)
  getDetail(@Param('workspaceId', ParseIntPipe) workspaceId: number, @Param('sessionId') sessionId: string) {
    return this.handoffService.getDetail(workspaceId, sessionId);
  }

  @Get(':sessionId/turns')
  @RequirePermission(Permission.HANDOFF_VIEW)
  listTurns(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Param('sessionId') sessionId: string,
    @Query(QUERY_PIPE) query: CursorPaginationQueryDto,
  ) {
    return this.handoffService.listTurns(workspaceId, sessionId, query.cursor, query.limit);
  }

  @Patch(':sessionId/claim')
  @RequirePermission(Permission.HANDOFF_WORK)
  claim(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.handoffService.claim(workspaceId, sessionId, user.userId);
  }

  @Patch(':sessionId/resolve')
  @RequirePermission(Permission.HANDOFF_WORK)
  resolve(@Param('workspaceId', ParseIntPipe) workspaceId: number, @Param('sessionId') sessionId: string) {
    return this.handoffService.resolve(workspaceId, sessionId);
  }
}
