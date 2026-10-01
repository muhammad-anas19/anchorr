import { Module } from '@nestjs/common';
import { UsageMeter } from './usage-meter.service';
import { QuotaService } from './quota.service';

// Top-level shared infrastructure (like cache/ and embedding/): answers and document
// embedding both meter usage, so it can belong to neither feature module.
@Module({
  providers: [UsageMeter, QuotaService],
  exports: [UsageMeter, QuotaService],
})
export class MeteringModule {}
