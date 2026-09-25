import { Module } from '@nestjs/common';
import { RealtimeBroadcaster } from './realtime-broadcaster.service';
import { AgentPresenceService } from './agent-presence.service';

@Module({
  providers: [RealtimeBroadcaster, AgentPresenceService],
  exports: [RealtimeBroadcaster, AgentPresenceService],
})
export class RealtimeModule {}
