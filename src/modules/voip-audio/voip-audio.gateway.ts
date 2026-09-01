import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { resolveCorsPolicy } from '../../config/bootstrap-security';
import { VoipAudioService } from './voip-audio.service';
import { FRAME_BYTES, PCM_CHANNELS, PCM_FORMAT, PCM_SAMPLE_RATE } from './voip-audio.constants';

function corsOrigin(): boolean | string[] {
  const policy = resolveCorsPolicy(process.env.CORS_ORIGINS, process.env.NODE_ENV);
  return policy.allowAnyOrigin ? true : policy.origins;
}

/** Largest microphone frame accepted from a client. Generous against the 20 ms frame the browser
 *  is told to send, but bounded — an unbounded binary payload is a memory amplifier. */
const MAX_FRAME_BYTES = FRAME_BYTES * 10;

/**
 * The operator's end of a call's audio.
 *
 * A separate namespace from the events gateway on purpose: this carries a continuous binary stream
 * at 50 frames a second, and mixing it into the event socket would put audio behind the same
 * rate limiters and message envelopes that exist to police sparse control traffic.
 *
 * One bridge per session, not per socket. A second operator connecting for the same session takes
 * the call over — two live microphones on one call would simply be mixed together, which is never
 * what anyone meant.
 */
@WebSocketGateway({ namespace: '/voip-audio', cors: { origin: corsOrigin(), credentials: true } })
export class VoipAudioGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(VoipAudioGateway.name);
  /** Which session each socket is carrying, so a disconnect closes the right bridge. */
  private readonly sessionOf = new Map<string, string>();

  constructor(
    private readonly audio: VoipAudioService,
    private readonly authService: AuthService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    // Never the query string: it leaks the credential into proxy and access logs.
    const auth = client.handshake.auth as { apiKey?: string } | undefined;
    const apiKey = auth?.apiKey || (client.handshake.headers['x-api-key'] as string | undefined);
    if (!apiKey) {
      client.emit('audio:error', { code: 'UNAUTHORIZED', message: 'API key required' });
      client.disconnect();
      return;
    }
    try {
      const key = await this.authService.validateApiKey(apiKey);
      // Placing and answering calls is an OPERATOR action, and so is speaking into one.
      if (key.role !== ApiKeyRole.OPERATOR && key.role !== ApiKeyRole.ADMIN) {
        client.emit('audio:error', { code: 'FORBIDDEN', message: 'operator role required' });
        client.disconnect();
        return;
      }
    } catch {
      client.emit('audio:error', { code: 'UNAUTHORIZED', message: 'invalid API key' });
      client.disconnect();
      return;
    }

    if (!VoipAudioService.isEnabled()) {
      // Say so rather than accepting audio into a void — without the devices the call is silent,
      // and a client that believes it is connected has no way to tell.
      client.emit('audio:error', {
        code: 'AUDIO_DISABLED',
        message: 'this gateway has no VoIP audio device (VOIP_AUDIO_ENABLED is not set)',
      });
      client.disconnect();
      return;
    }
    client.emit('audio:ready', {
      format: PCM_FORMAT,
      sampleRate: PCM_SAMPLE_RATE,
      channels: PCM_CHANNELS,
      frameBytes: FRAME_BYTES,
    });
  }

  /** Attach this socket to a session and start pumping the call's audio both ways. */
  @SubscribeMessage('audio:start')
  start(@ConnectedSocket() client: Socket, @MessageBody() body: { sessionId?: string }): void {
    const sessionId = body?.sessionId;
    if (!sessionId) {
      client.emit('audio:error', { code: 'BAD_REQUEST', message: 'sessionId required' });
      return;
    }
    this.sessionOf.set(client.id, sessionId);
    this.audio.open(sessionId, chunk => client.emit('audio:out', chunk));
    client.emit('audio:started', { sessionId });
    this.logger.log(`Operator ${client.id} carrying audio for ${sessionId}`);
  }

  /** One frame of the operator's microphone. Silently dropped when no bridge is open — a frame
   *  arriving just after a hang-up is normal, not an error worth a round trip. */
  @SubscribeMessage('audio:mic')
  mic(@ConnectedSocket() client: Socket, @MessageBody() frame: unknown): void {
    const sessionId = this.sessionOf.get(client.id);
    if (!sessionId) return;
    const buf = toBuffer(frame);
    if (!buf || buf.length === 0 || buf.length > MAX_FRAME_BYTES) return;
    this.audio.writeMic(sessionId, buf);
  }

  @SubscribeMessage('audio:stop')
  stop(@ConnectedSocket() client: Socket): void {
    this.release(client);
  }

  handleDisconnect(client: Socket): void {
    this.release(client);
  }

  private release(client: Socket): void {
    const sessionId = this.sessionOf.get(client.id);
    this.sessionOf.delete(client.id);
    if (sessionId) this.audio.close(sessionId);
  }
}

/** socket.io hands binary through as Buffer or ArrayBuffer depending on the client. */
function toBuffer(frame: unknown): Buffer | null {
  if (Buffer.isBuffer(frame)) return frame;
  if (frame instanceof ArrayBuffer) return Buffer.from(frame);
  if (ArrayBuffer.isView(frame)) return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  return null;
}
