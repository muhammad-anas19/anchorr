import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Logger, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { Workspace } from '../../database/entities/workspace.entity';
import { Membership } from '../../database/entities/membership.entity';
import { MembershipRole } from '../../database/entities/membership-role.enum';
import { ConversationSession } from '../../database/entities/conversation-session.entity';
import { ConversationSessionStatus } from '../../database/entities/conversation-session-status.enum';
import { AnswerService } from '../answer/answer.service';
import { RealtimeBroadcaster } from '../../realtime/realtime-broadcaster.service';
import { AgentPresenceService } from '../../realtime/agent-presence.service';
import { conversationRoom, agentsRoom } from '../../realtime/rooms';
import { WidgetMessageDto } from './dto/widget-message.dto';
import { JoinConversationDto } from './dto/join-conversation.dto';
import { AgentMessageDto } from './dto/agent-message.dto';
import { WidgetRateLimitGuard } from './widget-rate-limit.guard';

// A customer never has a login; an agent always does — the handshake shape itself is what
// tells handleConnection which branch to take (Phase 12's Q5/Q6 resolution: both kinds of
// connection live in this SAME namespace, since Socket.IO rooms don't cross namespaces, and
// an agent needs to join the exact rooms a customer's socket already sits in).
type WidgetSocketData =
  | { kind: 'customer'; workspaceId: number; sessionId: string }
  | { kind: 'agent'; workspaceId: number; userId: number };

// The widget's transport-level CORS is deliberately permissive (`origin: true`) — real
// enforcement happens in handleConnection, against each workspace's own allowlist. Unlike a
// REST call's CORS (Phase 11's Q5), a browser does NOT block a cross-origin WebSocket
// handshake by itself — only the server inspecting the `Origin` header on connect can reject
// it, which is exactly what this gateway does, and exactly why this differs from anything
// built in earlier, JWT-authenticated phases.
@WebSocketGateway({ cors: { origin: true }, namespace: 'widget' })
export class WidgetChatGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
  private readonly logger = new Logger(WidgetChatGateway.name);
  private readonly connections = new Map<string, WidgetSocketData>();

  @WebSocketServer()
  server: Server;

  constructor(
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    @InjectRepository(Membership) private readonly memberships: Repository<Membership>,
    @InjectRepository(ConversationSession) private readonly conversationSessions: Repository<ConversationSession>,
    private readonly answerService: AnswerService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly broadcaster: RealtimeBroadcaster,
    private readonly presence: AgentPresenceService,
  ) {}

  afterInit(server: Server): void {
    this.broadcaster.setServer(server);
  }

  async handleConnection(client: Socket): Promise<void> {
    const auth = client.handshake.auth ?? {};
    if (auth.publicKey) {
      await this.handleCustomerConnection(client, auth);
    } else if (auth.token) {
      await this.handleAgentConnection(client, auth);
    } else {
      client.disconnect(true);
    }
  }

  private async handleCustomerConnection(client: Socket, auth: Record<string, unknown>): Promise<void> {
    const publicKey = auth.publicKey as string | undefined;
    const sessionId = auth.sessionId as string | undefined;
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

    this.connections.set(client.id, { kind: 'customer', workspaceId: workspace.id, sessionId });
    await client.join(conversationRoom(sessionId));

    // The client's own 'connect' event fires as soon as the transport handshake completes —
    // it does NOT wait for this async handler (DB lookups, the room join above) to finish.
    // A message sent the instant 'connect' fires can arrive here before `connections.set`
    // above has run, hitting the "unknown connection" branch in handleMessage. 'ready' is an
    // explicit, later signal a client can actually wait on instead of the transport event.
    client.emit('ready');
  }

  // A real JWT + a real membership check — the exact same authorization an agent's REST
  // calls already go through (JwtAuthGuard + WorkspaceGuard + RolesGuard), just re-implemented
  // by hand here because a WebSocket handshake can't run through Nest's HTTP guard pipeline.
  private async handleAgentConnection(client: Socket, auth: Record<string, unknown>): Promise<void> {
    const token = auth.token as string | undefined;
    const workspaceId = Number(auth.workspaceId);

    if (!token || !workspaceId) {
      client.disconnect(true);
      return;
    }

    let userId: number;
    try {
      const payload = await this.jwtService.verifyAsync<{ sub: number }>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
      userId = payload.sub;
    } catch {
      client.disconnect(true);
      return;
    }

    const membership = await this.memberships.findOne({ where: { workspaceId, userId } });
    if (!membership || membership.role === MembershipRole.VIEWER) {
      client.disconnect(true);
      return;
    }

    this.connections.set(client.id, { kind: 'agent', workspaceId, userId });
    // Presence is the live socket, not a login: an agent who closed the tab without logging
    // out is not available to take a conversation, and one who logged in this morning and
    // walked away is not either.
    this.presence.add(workspaceId, userId);
    await client.join(agentsRoom(workspaceId));
    client.emit('ready');
  }

  handleDisconnect(client: Socket): void {
    const connection = this.connections.get(client.id);
    if (connection?.kind === 'agent') {
      this.presence.remove(connection.workspaceId, connection.userId);
    }
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
    if (!connection || connection.kind !== 'customer') {
      client.disconnect(true);
      return;
    }

    const room = conversationRoom(connection.sessionId);
    const session = await this.conversationSessions.findOne({
      where: { workspaceId: connection.workspaceId, sessionId: connection.sessionId },
    });

    // Once a human has claimed this session, the AI never runs for it again — no Gemini call,
    // no risk of an AI reply landing right after (or instead of) the agent's own. The message
    // is relayed live into the room the claiming agent has joined; a resolved session (status
    // moves off CLAIMED) automatically falls back to the AI pipeline below with no extra code.
    if (session?.status === ConversationSessionStatus.CLAIMED) {
      this.server.to(room).emit('customer-message', { question: dto.question });
      return;
    }

    const result = await this.answerService.answer(connection.workspaceId, dto.question, connection.sessionId);

    // Broadcast to the whole room, including the sender, rather than acking the caller
    // directly — the same room a human agent's own connection (Phase 12) joins once they
    // claim the session, so this transport never needed reworking once handoff existed
    // (this phase's Q10).
    this.server.to(room).emit('answer', result);
  }

  // An agent's own socket joins a specific conversation's room only after this — never
  // automatically at connect time, since one agent connection may have several claimed
  // conversations open across different browser tabs, or none yet.
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      exceptionFactory: (errors) => new WsException(errors),
    }),
  )
  @SubscribeMessage('join-conversation')
  async handleJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: JoinConversationDto,
  ): Promise<void> {
    const connection = this.connections.get(client.id);
    if (!connection || connection.kind !== 'agent') {
      client.disconnect(true);
      return;
    }

    const session = await this.conversationSessions.findOne({
      where: { workspaceId: connection.workspaceId, sessionId: dto.sessionId },
    });
    if (!session || session.claimedByUserId !== connection.userId) {
      // An explicit, named error event rather than throwing WsException — this project
      // prefers a concrete, typed signal the client can reliably listen for over the
      // framework's generic 'exception' event.
      client.emit('join-conversation-error', { message: 'You have not claimed this conversation.' });
      return;
    }

    await client.join(conversationRoom(dto.sessionId));
  }

  // Deliberately not rate-limited like the customer-facing 'message' handler — an agent is
  // an authenticated, trusted staff member, not an anonymous holder of a copyable public key
  // (Q9's whole reasoning for why the widget rate limit exists in the first place).
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      exceptionFactory: (errors) => new WsException(errors),
    }),
  )
  @SubscribeMessage('agent-message')
  async handleAgentMessage(@ConnectedSocket() client: Socket, @MessageBody() dto: AgentMessageDto): Promise<void> {
    const connection = this.connections.get(client.id);
    if (!connection || connection.kind !== 'agent') {
      client.disconnect(true);
      return;
    }

    const session = await this.conversationSessions.findOne({
      where: { workspaceId: connection.workspaceId, sessionId: dto.sessionId },
    });
    if (!session || session.claimedByUserId !== connection.userId) {
      client.emit('agent-message-error', { message: 'You have not claimed this conversation.' });
      return;
    }

    this.server.to(conversationRoom(dto.sessionId)).emit('agent-message', { message: dto.message });
  }
}
