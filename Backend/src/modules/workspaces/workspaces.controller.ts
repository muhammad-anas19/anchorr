import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, Query, UseGuards, ValidationPipe } from '@nestjs/common';
import { ListMembersQueryDto } from './dto/list-members-query.dto';
import { CurrentUser, CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/permissions/permission.enum';
import { WorkspacesService } from './workspaces.service';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { UpdateAllowedOriginsDto } from './dto/update-allowed-origins.dto';

const QUERY_PIPE = new ValidationPipe({ transform: true, whitelist: true });

@Controller('workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceGuard, PermissionsGuard)
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Get('members')
  @RequirePermission(Permission.MEMBERS_VIEW)
  listMembers(@Param('workspaceId', ParseIntPipe) workspaceId: number, @Query(QUERY_PIPE) query: ListMembersQueryDto) {
    return this.workspacesService.listMembers(workspaceId, query);
  }

  @Get('roles')
  @RequirePermission(Permission.MEMBERS_VIEW)
  listRoles() {
    return this.workspacesService.listRoles();
  }

  @Patch('members/:userId')
  @RequirePermission(Permission.MEMBERS_MANAGE)
  updateMemberRole(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.workspacesService.updateMemberRole(workspaceId, userId, dto.role);
  }

  @Delete('members/:userId')
  @RequirePermission(Permission.MEMBERS_MANAGE)
  removeMember(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workspacesService.removeMember(workspaceId, user.userId, userId);
  }

  @Post('leave')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.WORKSPACE_LEAVE)
  leave(@Param('workspaceId', ParseIntPipe) workspaceId: number, @CurrentUser() user: CurrentUserPayload) {
    return this.workspacesService.leave(workspaceId, user.userId);
  }

  @Post('transfer-ownership')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.WORKSPACE_TRANSFER_OWNERSHIP)
  transferOwnership(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: TransferOwnershipDto,
  ) {
    return this.workspacesService.transferOwnership(workspaceId, user.userId, dto.userId);
  }

  @Get('widget-settings')
  @RequirePermission(Permission.WIDGET_VIEW)
  getWidgetSettings(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
    return this.workspacesService.getWidgetSettings(workspaceId);
  }

  @Patch('widget-settings')
  @RequirePermission(Permission.WIDGET_MANAGE)
  updateWidgetSettings(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Body() dto: UpdateAllowedOriginsDto,
  ) {
    return this.workspacesService.updateAllowedOrigins(workspaceId, dto.allowedOrigins);
  }
}
