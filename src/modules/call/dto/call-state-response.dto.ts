import { ApiProperty } from '@nestjs/swagger';

export class CallStateResponseDto {
  @ApiProperty({
    description: 'The call this session currently holds, or null when there is none.',
    example: 'A1B2C3',
    nullable: true,
  })
  callId!: string | null;

  @ApiProperty({
    description:
      'Whether the call is connected — media is flowing. False while an outgoing call is still ' +
      'ringing, which is the distinction no event reports.',
    example: false,
  })
  connected!: boolean;

  @ApiProperty({ description: 'Whether this side placed the call.', example: true })
  outgoing!: boolean;

  @ApiProperty({
    description: 'The other party, as WhatsApp addresses them.',
    example: '919876543210@c.us',
    nullable: true,
  })
  peer!: string | null;
}
