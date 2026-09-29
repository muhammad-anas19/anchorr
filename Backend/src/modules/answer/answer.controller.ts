import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
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

  @Post()
  ask(@Param('workspaceId', ParseIntPipe) workspaceId: number, @Body() dto: AskDto) {
    return this.answerService.answer(workspaceId, dto.question, dto.sessionId ?? null);
  }

  @Get('config')
  getConfig(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
    return this.answerService.getConfig(workspaceId);
  }
}
