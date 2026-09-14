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
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { MembershipRole } from '../../database/entities/membership-role.enum';
import { DocumentsService } from './documents.service';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

@Controller('workspaces/:workspaceId/documents')
@UseGuards(JwtAuthGuard, WorkspaceGuard, RolesGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post()
  @Roles(MembershipRole.OWNER, MembershipRole.AGENT)
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
  list(@Param('workspaceId', ParseIntPipe) workspaceId: number) {
    return this.documentsService.listForWorkspace(workspaceId);
  }

  @Get(':documentId')
  getOne(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Param('documentId', ParseIntPipe) documentId: number,
  ) {
    return this.documentsService.getOne(workspaceId, documentId);
  }

  @Delete(':documentId')
  @Roles(MembershipRole.OWNER, MembershipRole.AGENT)
  remove(
    @Param('workspaceId', ParseIntPipe) workspaceId: number,
    @Param('documentId', ParseIntPipe) documentId: number,
  ) {
    return this.documentsService.remove(workspaceId, documentId);
  }
}
