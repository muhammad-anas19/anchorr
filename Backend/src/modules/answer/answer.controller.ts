import { Body, Controller, Get, Headers, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { scopedIdempotencyKey } from '../../common/utils/idempotency-key';
import { AskRateLimitGuard } from '../../common/guards/ask-rate-limit.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/permissions/permission.enum';
import { AnswerService } from './answer.service';
import { AskDto } from './dto/ask.dto';

@Controller('workspaces/:workspaceId/ask')
@UseGuards(JwtAuthGuard, WorkspaceGuard, PermissionsGuard)
// Class-level: every route here needs the same permission. The old RolesGuard ignored class-
// level metadata entirely; PermissionsGuard reads handler then class.
@RequirePermission(Permission.KNOWLEDGE_QUERY)
export class AnswerController {
  constructor(private readonly answerService: AnswerService) {}

  // Idempotency-Key is the standard header for this (Stripe's convention, now an IETF draft):
  // the client generates it once and resends it unchanged on a retry.
  // Method-level, so it runs after the class guards: only an authenticated member of this
  // workspace can spend (or learn anything from) the workspace's rate-limit budget.
  @Post()
  @UseGuards(AskRateLimitGuard)
  ask(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Body() dto: AskDto,
    @CurrentUser() user: CurrentUserPayload,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = scopedIdempotencyKey(`user:${user.userId}`, idempotencyKey);
    return this.answerService.answer(workspaceId, dto.question, dto.sessionId ?? null, key);
  }

  @Get('config')
  getConfig(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
    return this.answerService.getConfig(workspaceId);
  }
}
