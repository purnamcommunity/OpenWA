import { Controller, Post, Get, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { CallAckResponseDto } from './dto/call-response.dto';
import { CreateCallLinkDto } from './dto/create-call-link.dto';
import { PlaceCallDto } from './dto/place-call.dto';
import { PlaceCallResponseDto } from './dto/place-call-response.dto';
import { AnswerCallDto } from './dto/answer-call.dto';
import { CallStateResponseDto } from './dto/call-state-response.dto';
import { CallLinkResponseDto } from './dto/call-link-response.dto';
import { CallService } from './call.service';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { ENGINE_NOT_READY_409 } from '../../common/openapi/engine-status-responses';

@ApiTags('calls')
@Controller('sessions/:sessionId/calls')
export class CallController {
  constructor(private readonly callService: CallService) {}

  @Post('link')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate a shareable WhatsApp call link' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'The generated link', type: CallLinkResponseDto })
  @ApiResponse({ status: 400, description: 'Session is not started, or an invalid type / startTime' })
  @ApiResponse({ status: 403, description: 'WhatsApp generated no link for this request' })
  @ApiResponse({
    status: 503,
    description:
      'WhatsApp did not answer within the request budget. The link may or may not have been created — ' +
      'the gateway stopped waiting for a reply that never came.',
  })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  async createLink(
    @Param('sessionId') sessionId: string,
    @Body() dto: CreateCallLinkDto,
  ): Promise<CallLinkResponseDto> {
    const link = await this.callService.createCallLink(sessionId, dto.type, dto.startTime);
    return { link };
  }

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Place a voice or video call',
    description:
      'Sends a call offer and returns once it is away — NOT when the other party answers; the ' +
      'outcome arrives as a `call.*` event. The session must have a capture device ' +
      '(VOIP_AUDIO_ENABLED), or the call connects carrying silence. One call per session at a time.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Offer sent', type: PlaceCallResponseDto })
  @ApiResponse({ status: 400, description: 'Session is not started, or an invalid chatId' })
  @ApiResponse({
    status: 403,
    description: 'WhatsApp refused the call, the id is not callable, or this session is already on a call',
  })
  @ApiResponse({ status: 501, description: 'The active engine cannot place calls (Baileys has no media stack)' })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  async place(@Param('sessionId') sessionId: string, @Body() dto: PlaceCallDto): Promise<PlaceCallResponseDto> {
    const callId = await this.callService.placeCall(sessionId, dto.chatId, dto.isVideo === true);
    return { success: true, callId };
  }

  @Post('voip/warmup')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Boot the VoIP stack ahead of a call',
    description:
      'WhatsApp Web keeps VoIP in lazily-fetched chunks a headless session never loads on its own, ' +
      'so the first call of a session otherwise waits on that fetch. Idempotent.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'The VoIP stack is running', type: CallAckResponseDto })
  @ApiResponse({ status: 400, description: 'Session is not started' })
  @ApiResponse({ status: 403, description: 'VoIP initialization failed, or needs a session restart' })
  @ApiResponse({ status: 501, description: 'The active engine has no VoIP stack (Baileys)' })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  async warmup(@Param('sessionId') sessionId: string) {
    await this.callService.ensureVoipReady(sessionId);
    return { success: true };
  }

  @Post(':callId/answer')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Answer a ringing incoming call' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'callId', description: 'Call ID from the call.received event' })
  @ApiResponse({ status: 200, description: 'Call answered', type: CallAckResponseDto })
  @ApiResponse({ status: 400, description: 'Session is not started' })
  @ApiResponse({ status: 403, description: 'The VoIP stack refused the answer' })
  @ApiResponse({ status: 404, description: 'Call not found or no longer ringing' })
  @ApiResponse({ status: 501, description: 'The active engine cannot answer calls (Baileys has no media stack)' })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  async answer(
    @Param('sessionId') sessionId: string,
    @Param('callId') callId: string,
    @Body() dto: AnswerCallDto = {},
  ) {
    await this.callService.answerCall(sessionId, callId, dto?.withVideo === true);
    return { success: true };
  }

  @Post(':callId/end')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Hang up the call this session is on',
    description: 'Ends a connected call. Use reject for one that is still ringing.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'callId', description: 'Call ID from the call.received event or a placed call' })
  @ApiResponse({ status: 200, description: 'Call ended', type: CallAckResponseDto })
  @ApiResponse({ status: 400, description: 'Session is not started' })
  @ApiResponse({ status: 403, description: 'The VoIP stack refused the hang-up, or no call is running' })
  @ApiResponse({ status: 501, description: 'The active engine cannot end calls (Baileys has no media stack)' })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  async end(@Param('sessionId') sessionId: string, @Param('callId') callId: string) {
    await this.callService.endCall(sessionId, callId);
    return { success: true };
  }

  @Get('state')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary: "What this session's current call is doing",
    description:
      'Polled rather than pushed: an outgoing call raises no event when the far end answers — the ' +
      'call events report outcomes, which arrive once a call is over — so a client showing ' +
      '"ringing" and then a duration has to ask.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'The current call, or a null callId', type: CallStateResponseDto })
  @ApiResponse({ status: 400, description: 'Session is not started' })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  @ApiResponse({ status: 501, description: 'The active engine cannot report call state' })
  async state(@Param('sessionId') sessionId: string): Promise<CallStateResponseDto> {
    return this.callService.callState(sessionId);
  }

  @Post(':callId/reject')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a ringing incoming call' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'callId', description: 'Call ID from the call.received event' })
  @ApiResponse({ status: 200, description: 'Call rejected', type: CallAckResponseDto })
  @ApiResponse({ status: 400, description: 'Session is not started' })
  @ApiResponse({ status: 404, description: 'Call not found or no longer ringing' })
  @ApiResponse({
    status: 503,
    description:
      'WhatsApp did not answer within the request budget. The change may or may not have been applied — ' +
      'the gateway stopped waiting for a confirmation that never came.',
  })
  @ApiResponse({ status: 409, description: ENGINE_NOT_READY_409 })
  async reject(@Param('sessionId') sessionId: string, @Param('callId') callId: string) {
    await this.callService.rejectCall(sessionId, callId);
    return { success: true };
  }
}
