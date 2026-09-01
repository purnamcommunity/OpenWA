import { ApiProperty } from '@nestjs/swagger';

export class PlaceCallResponseDto {
  @ApiProperty({ description: 'Always true — the offer was sent.', example: true })
  success!: boolean;

  @ApiProperty({
    description:
      "The engine's call id, usable with the answer/end/reject routes. Null when the offer went " +
      'out but WhatsApp had not yet published an id for it — the id then arrives on the next ' +
      '`call.*` event instead.',
    example: 'A1B2C3D4E5F6',
    nullable: true,
  })
  callId!: string | null;
}
