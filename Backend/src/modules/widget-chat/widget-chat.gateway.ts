import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Logger, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Server, Socket } from 'socket.io';
import { Workspace } from '../../database/entities/workspace.entity';
import { AnswerService } from '../answer/answer.service';
import { WidgetMessageDto } from './dto/widget-message.dto';
import { WidgetRateLimitGuard } from './widget-rate-limit.guard';

interface WidgetSocketData {
  workspaceId: number;
  sessionId: string;
}

function conversationRoom(sessionId: string): string {
  return `conversation:${sessionId}`;
}

// The widget's transport-level CORS is deliberately permissive (`origin: true`) — real
// enforcement happens in handleConnection, against each workspace's own allowlist. Unlike a
// REST call's CORS (Phase 11's Q5), a browser does NOT block a cross-origin WebSocket
// handshake by itself — only the server inspecting the `Origin` header on connect can reject
// it, which is exactly what this gateway does, and exactly why this differs from anything
// built in earlier, JWT-authenticated phases.
@WebSocketGateway({ cors: { origin: true }, namespace: 'widget' })
export class WidgetChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(WidgetChatGateway.name);
  private readonly connections = new Map<string, WidgetSocketData>();

  @WebSocketServer()
  server: Server;

  constructor(
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    private readonly answerService: AnswerService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const publicKey = client.handshake.auth?.publicKey as string | undefined;
    const sessionId = client.handshake.auth?.sessionId as string | undefined;
    const origin = client.handshake.headers.origin;

    if (!publicKey || !sessionId) {
      client.disconnect(true);
      return;
    }

    const workspace = await this.workspaces.findOne({ where: { publicKey } });
    if (!workspace) {
      client.disconnect(true);
      return;
    }

    // Fail closed: a workspace with no allowlist configured yet accepts connections from
    // nowhere, not everywhere — an unconfigured public key shouldn't be usable from an
    // arbitrary page just because its owner hasn't locked it down yet.
    if (!origin || !workspace.allowedOrigins.includes(origin)) {
      this.logger.warn(`Rejected widget connection for workspace ${workspace.id}: origin "${origin}" not allowed`);
      client.disconnect(true);
      return;
    }

    this.connections.set(client.id, { workspaceId: workspace.id, sessionId });
    await client.join(conversationRoom(sessionId));
  }

  handleDisconnect(client: Socket): void {
    this.connections.delete(client.id);
  }

  @UseGuards(WidgetRateLimitGuard)
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      exceptionFactory: (errors) => new WsException(errors),
    }),
  )
  @SubscribeMessage('message')
  async handleMessage(@ConnectedSocket() client: Socket, @MessageBody() dto: WidgetMessageDto): Promise<void> {
    const connection = this.connections.get(client.id);
    if (!connection) {
      client.disconnect(true);
      return;
    }

    const result = await this.answerService.answer(connection.workspaceId, dto.question, connection.sessionId);

    // Broadcast to the whole room, including the sender, rather than acking the caller
    // directly — the same room a future human agent's own connection (Phase 12) will join,
    // so this transport never needs reworking once handoff exists (this phase's Q10).
    this.server.to(conversationRoom(connection.sessionId)).emit('answer', result);
  }
}
