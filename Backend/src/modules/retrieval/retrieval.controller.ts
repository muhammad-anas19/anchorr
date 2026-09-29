import { Body, Controller, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/permissions/permission.enum';
import { RetrievalService } from './retrieval.service';
import { RetrieveDto } from './dto/retrieve.dto';

@Controller('workspaces/:workspaceId/retrieve')
@UseGuards(JwtAuthGuard, WorkspaceGuard, PermissionsGuard)
// Class-level: every route here needs the same permission. The old RolesGuard ignored class-
// level metadata entirely; PermissionsGuard reads handler then class.
@RequirePermission(Permission.KNOWLEDGE_QUERY)
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
