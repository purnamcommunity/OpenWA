import { Controller, Param, Post, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiProperty, ApiResponse } from '@nestjs/swagger';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { VoipAudioService } from './voip-audio.service';
import { VoipAudioTokenService } from './voip-audio-token.service';

export class AudioTokenResponseDto {
  @ApiProperty({ description: 'Single-use handshake token for the /voip-audio socket namespace' })
  token!: string;

  @ApiProperty({ description: 'Seconds until the token expires unredeemed' })
  expiresInSeconds!: number;
}

/**
 * Mints browser credentials for the audio socket. A separate controller from CallController
 * because it belongs to the audio bridge, not the call lifecycle — the socket it grants access to
 * lives in this module.
 */
@ApiTags('calls')
@Controller('sessions/:sessionId/calls')
export class VoipAudioController {
  constructor(private readonly tokens: VoipAudioTokenService) {}

  @Post('audio-token')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Mint a single-use token for a browser to open this session's audio socket",
    description:
      'The caller (which holds an API key) passes the token to an operator’s browser; the ' +
      'browser presents it as `auth.token` in the /voip-audio socket.io handshake and may then ' +
      'carry audio for this session only. One connection per token; expires unredeemed after ' +
      'about a minute.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID the token is bound to' })
  @ApiResponse({ status: 200, description: 'Token minted', type: AudioTokenResponseDto })
  @ApiResponse({ status: 503, description: 'This gateway has no VoIP audio device (VOIP_AUDIO_ENABLED is not set)' })
  mint(@Param('sessionId') sessionId: string): AudioTokenResponseDto {
    if (!VoipAudioService.isEnabled()) {
      // Fail at mint time rather than letting the browser connect into a bridge that can only
      // refuse it — the caller still has time to fall back to its relay path.
      throw new ServiceUnavailableException('this gateway has no VoIP audio device (VOIP_AUDIO_ENABLED is not set)');
    }
    return this.tokens.mint(sessionId);
  }
}
