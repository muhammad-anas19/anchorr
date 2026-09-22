import { Module } from '@nestjs/common';
import { RealtimeBroadcaster } from './realtime-broadcaster.service';

@Module({
  providers: [RealtimeBroadcaster],
  exports: [RealtimeBroadcaster],
})
export class RealtimeModule {}
