import { Body, Controller, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { RetrievalService } from './retrieval.service';
import { RetrieveDto } from './dto/retrieve.dto';

@Controller('workspaces/:workspaceId/retrieve')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class RetrievalController {
  constructor(private readonly retrievalService: RetrievalService) {}

  @Post()
  async retrieve(@Param('workspaceId', ParseIntPipe) workspaceId: number, @Body() dto: RetrieveDto) {
    // The query embedding is internal plumbing (768 floats) — useful to AnswerService, noise in
    // a debugging endpoint's response.
    const { chunks } = await this.retrievalService.retrieveRelevantChunks(workspaceId, dto.query, dto.k);
    return { chunks };
  }
}
