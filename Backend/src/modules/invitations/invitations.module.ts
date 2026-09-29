import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Membership } from '../../database/entities/membership.entity';
import { Invitation } from '../../database/entities/invitation.entity';
import { TenancyModule } from '../tenancy/tenancy.module';
import { RedisModule } from '../../redis/redis.module';
import { EmailModule } from '../../email/email.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { PublicInvitationsController } from './public-invitations.controller';
import { InvitationAcceptanceService } from './invitation-acceptance.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  // Membership for WorkspaceGuard's request-scoped chain — the same requirement DocumentsModule
  // documents (Phase 3's DI failure).
  imports: [TypeOrmModule.forFeature([Invitation, Membership]), TenancyModule, RedisModule, EmailModule, AuthModule],
  controllers: [InvitationsController, PublicInvitationsController],
  providers: [InvitationsService, InvitationAcceptanceService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
