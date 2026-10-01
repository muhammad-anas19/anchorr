import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Membership } from '../../database/entities/membership.entity';
import { TenancyModule } from '../tenancy/tenancy.module';
import { MeteringModule } from '../../metering/metering.module';
import { RedisModule } from '../../redis/redis.module';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

// Reporting over the meter. Writing usage belongs to metering/ (shared infra); reading it for
// people is this feature.
@Module({
  imports: [TypeOrmModule.forFeature([Membership]), TenancyModule, MeteringModule, RedisModule],
  controllers: [UsageController],
  providers: [UsageService],
})
export class UsageModule {}
