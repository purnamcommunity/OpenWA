import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VoipAudioService } from './voip-audio.service';
import { VoipAudioGateway } from './voip-audio.gateway';
import { VoipAudioTokenService } from './voip-audio-token.service';
import { VoipAudioController } from './voip-audio.controller';

/** The operator's end of a call's audio — see ./voip-audio.service.ts for the PulseAudio topology. */
@Module({
  imports: [AuthModule],
  controllers: [VoipAudioController],
  providers: [VoipAudioService, VoipAudioGateway, VoipAudioTokenService],
  exports: [VoipAudioService],
})
export class VoipAudioModule {}
