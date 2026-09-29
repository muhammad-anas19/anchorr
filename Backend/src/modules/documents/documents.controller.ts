import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Permission } from '../../common/permissions/permission.enum';
import { CurrentUser, CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { DocumentsService } from './documents.service';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

@Controller('workspaces/:workspaceId/documents')
@UseGuards(JwtAuthGuard, WorkspaceGuard, PermissionsGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post()
  @RequirePermission(Permission.DOCUMENTS_MANAGE)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
    }),
  )
  upload(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided. Send it as multipart/form-data under the "file" field.');
    }
    return this.documentsService.upload(workspaceId, user.userId, file);
  }

  @Get()
  @RequirePermission(Permission.DOCUMENTS_VIEW)
  list(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
    return this.documentsService.listForWorkspace(workspaceId);
  }

  @Get(':documentId')
  @RequirePermission(Permission.DOCUMENTS_VIEW)
  getOne(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Param('documentId', ParseIntPipe) documentId: number,
  ) {
    return this.documentsService.getOne(workspaceId, documentId);
  }

  @Get(':documentId/progress')
  @RequirePermission(Permission.DOCUMENTS_VIEW)
  getProgress(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Param('documentId', ParseIntPipe) documentId: number,
  ) {
    return this.documentsService.getProgress(workspaceId, documentId);
  }

  @Delete(':documentId')
  @RequirePermission(Permission.DOCUMENTS_MANAGE)
  remove(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Param('documentId', ParseIntPipe) documentId: number,
  ) {
    return this.documentsService.remove(workspaceId, documentId);
  }
}
