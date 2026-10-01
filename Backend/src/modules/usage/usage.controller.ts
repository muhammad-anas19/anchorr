import { Controller, Get, Param, ParseIntPipe, Query, UseGuards, ValidationPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/permissions/permission.enum';
import { UsageService } from './usage.service';
import { UsageQueryDto } from './dto/usage-query.dto';

const QUERY_PIPE = new ValidationPipe({ transform: true, whitelist: true });

@Controller('workspaces/:workspaceId/usage')
@UseGuards(JwtAuthGuard, WorkspaceGuard, PermissionsGuard)
@RequirePermission(Permission.USAGE_VIEW)
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  report(@Param('workspaceId', ParseIntPipe) workspaceId: number, @Query(QUERY_PIPE) query: UsageQueryDto) {
    return this.usage.report(workspaceId, query.from, query.to);
  }
}
