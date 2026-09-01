import { Injectable } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { CallLinkType, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * Owns engine access for call operations. Controllers depend on this service instead of
 * reaching for the raw `IWhatsAppEngine` via `sessionService.getEngine`, so the "session not
 * started" guard lives in one place (mirrors GroupService).
 */
@Injectable()
export class CallService {
  constructor(private readonly engines: EngineRegistry) {}

  private getEngine(sessionId: string): IWhatsAppEngine {
    // EngineRegistry.require()'s default is this exact 400 "Session is not started".
    return this.engines.require(sessionId);
  }

  /**
   * Reject a currently-ringing incoming call. An unknown or no-longer-ringing callId surfaces
   * as 404 via the adapter's CallNotFoundError; EngineNotSupportedError would map to 501 (both
   * engines support rejectCall today, so no special-casing here).
   */
  rejectCall(sessionId: string, callId: string): Promise<void> {
    return this.getEngine(sessionId).rejectCall(callId);
  }

  /**
   * Boot the VoIP stack ahead of a call. Exposed on its own because the first boot on a session
   * fetches WhatsApp Web's VoIP chunks, which is slow enough that paying it inside placeCall makes
   * the first call of a session look hung.
   */
  ensureVoipReady(sessionId: string): Promise<void> {
    return this.getEngine(sessionId).ensureVoipReady();
  }

  /**
   * Place a call. Resolves when the offer is away, not when it is answered — the outcome arrives
   * as a `call.*` event. EngineNotSupportedError maps to 501 on Baileys, which has no media stack;
   * an engine refusal (already on a call, uncallable id) maps to 403.
   */
  placeCall(sessionId: string, chatId: string, isVideo: boolean): Promise<string | null> {
    return this.getEngine(sessionId).placeCall(chatId, isVideo);
  }

  /**
   * Answer a ringing call. Like rejectCall, an unknown or no-longer-ringing callId surfaces as 404
   * via the adapter's CallNotFoundError.
   */
  answerCall(sessionId: string, callId: string, withVideo = false): Promise<void> {
    return this.getEngine(sessionId).answerCall(callId, withVideo);
  }

  /** Hang up the call this session is on. */
  endCall(sessionId: string, callId: string): Promise<void> {
    return this.getEngine(sessionId).endCall(callId);
  }

  /**
   * Generate a shareable call link. A WhatsApp-side refusal (no link generated) surfaces as 403 via
   * the adapter's EngineRefusedError rather than as a success carrying an empty string.
   */
  createCallLink(sessionId: string, type: CallLinkType, startTime: number): Promise<string> {
    return this.getEngine(sessionId).createCallLink(type, startTime);
  }
}
