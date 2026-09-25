import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { AnswerService } from './answer.service';
import { AskDto } from './dto/ask.dto';

@Controller('workspaces/:workspaceId/ask')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
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
