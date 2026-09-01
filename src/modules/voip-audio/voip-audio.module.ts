import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VoipAudioService } from './voip-audio.service';
import { VoipAudioGateway } from './voip-audio.gateway';

/** The operator's end of a call's audio — see ./voip-audio.service.ts for the PulseAudio topology. */
@Module({
  imports: [AuthModule],
  providers: [VoipAudioService, VoipAudioGateway],
  exports: [VoipAudioService],
})
export class VoipAudioModule {}
