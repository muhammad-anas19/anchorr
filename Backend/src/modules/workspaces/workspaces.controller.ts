import { Body, Controller, Get, Param, ParseIntPipe, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { MembershipRole } from '../../database/entities/membership-role.enum';
import { WorkspacesService } from './workspaces.service';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';

@Controller('workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceGuard, RolesGuard)
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Get('members')
  listMembers(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
    return this.workspacesService.listMembers(workspaceId);
  }

  @Patch('members/:userId')
  @Roles(MembershipRole.OWNER)
  updateMemberRole(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.workspacesService.updateMemberRole(workspaceId, userId, dto.role);
  }
}
